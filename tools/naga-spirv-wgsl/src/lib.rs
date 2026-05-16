// SPIR-V → WGSL transpiler with a C ABI, for the WebGPU hardware
// renderer. Dolphin's shader generators emit GLSL; glslang (already
// linked in the wasm build) compiles that to SPIR-V; this crate does
// the final SPIR-V → WGSL hop the browser's WebGPU requires.
//
// Built as a `staticlib` for `wasm32-unknown-emscripten` and linked
// straight into dolphin_web_core, so `WebGPUShaderTranslator::
// SpirvToWgsl` can call `naga_spirv_to_wgsl` synchronously — no async
// worker round-trip, no change to Dolphin's pipeline-creation path.
//
// `panic = "abort"` in release: a panic here would abort the whole
// game wasm, so every path below is panic-free (no unwrap/expect/
// indexing — all Results handled, return null on any failure).

use std::cell::RefCell;
use std::os::raw::c_char;

// Day-30: last failure reason, so the C++/JS side can see *why* Naga
// rejected a real Dolphin shader (frontend parse vs validation vs
// WGSL backend, plus the message) instead of just a null. Thread-
// local because naga_spirv_to_wgsl is called synchronously on the
// single video pthread; valid until the next call on that thread.
thread_local! {
    static LAST_ERROR: RefCell<Option<std::ffi::CString>> = RefCell::new(None);
}

fn set_last_error(msg: String) {
    // Truncate hard so a giant naga dump can't blow the FFI copy.
    let mut m = msg;
    if m.len() > 600 {
        m.truncate(600);
    }
    let cs = std::ffi::CString::new(m)
        .unwrap_or_else(|_| std::ffi::CString::new("<err string had interior NUL>").unwrap());
    LAST_ERROR.with(|e| *e.borrow_mut() = Some(cs));
}

/// Pointer to the last failure message (NUL-terminated, owned by the
/// crate, valid until the next naga_spirv_to_wgsl call on this
/// thread), or null if the last call succeeded / none yet.
#[no_mangle]
pub extern "C" fn naga_last_error() -> *const c_char {
    LAST_ERROR.with(|e| match &*e.borrow() {
        Some(cs) => cs.as_ptr(),
        None => std::ptr::null(),
    })
}

/// Translate a SPIR-V module to WGSL.
///
/// `spirv_ptr`        — pointer to SPIR-V words (u32, little-endian as
///                      produced by glslang in the same wasm memory).
/// `spirv_word_count` — number of u32 words.
///
/// Returns a NUL-terminated UTF-8 WGSL C string allocated with the
/// shared (emscripten) allocator, or null on any failure. The caller
/// must release it with `naga_free_wgsl`.
#[no_mangle]
pub extern "C" fn naga_spirv_to_wgsl(
    spirv_ptr: *const u32,
    spirv_word_count: usize,
) -> *mut c_char {
    if spirv_ptr.is_null() || spirv_word_count == 0 {
        return std::ptr::null_mut();
    }

    // SAFETY: the C side passes a valid pointer to `spirv_word_count`
    // contiguous u32 words living in the same linear memory. We only
    // read it.
    let words: &[u32] = unsafe { std::slice::from_raw_parts(spirv_ptr, spirv_word_count) };

    match translate(words) {
        Ok(wgsl) => {
            LAST_ERROR.with(|e| *e.borrow_mut() = None);
            match std::ffi::CString::new(wgsl) {
                Ok(cstr) => cstr.into_raw(),
                Err(_) => {
                    set_last_error("WGSL output had an interior NUL".into());
                    std::ptr::null_mut()
                }
            }
        }
        Err(msg) => {
            set_last_error(msg);
            std::ptr::null_mut()
        }
    }
}

/// Free a string returned by `naga_spirv_to_wgsl`. Null-safe.
#[no_mangle]
pub extern "C" fn naga_free_wgsl(ptr: *mut c_char) {
    if ptr.is_null() {
        return;
    }
    // SAFETY: `ptr` was produced by CString::into_raw above; reclaim
    // and drop it. Both sides share emscripten's allocator under
    // wasm32-unknown-emscripten, so this is the correct free.
    unsafe {
        drop(std::ffi::CString::from_raw(ptr));
    }
}

fn translate(words: &[u32]) -> Result<String, String> {
    let options = naga::front::spv::Options::default();
    let module = naga::front::spv::Frontend::new(words.iter().copied(), &options)
        .parse()
        .map_err(|e| format!("spv-frontend: {e}"))?;

    // The WGSL backend needs validation info. Allow the full
    // capability set — Dolphin emits a wide range of features and we
    // don't want to reject otherwise-valid modules here.
    let mut validator = naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::all(),
    );
    let info = validator
        .validate(&module)
        .map_err(|e| format!("validate: {e}"))?;

    naga::back::wgsl::write_string(&module, &info, naga::back::wgsl::WriterFlags::empty())
        .map_err(|e| format!("wgsl-backend: {e}"))
}
