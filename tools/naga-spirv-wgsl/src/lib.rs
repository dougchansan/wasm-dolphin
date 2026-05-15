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

use std::os::raw::c_char;

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
        Some(wgsl) => match std::ffi::CString::new(wgsl) {
            Ok(cstr) => cstr.into_raw(),
            Err(_) => std::ptr::null_mut(), // interior NUL — shouldn't happen for WGSL text
        },
        None => std::ptr::null_mut(),
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

fn translate(words: &[u32]) -> Option<String> {
    let options = naga::front::spv::Options::default();
    let module = naga::front::spv::Frontend::new(words.iter().copied(), &options)
        .parse()
        .ok()?;

    // The WGSL backend needs validation info. Allow the full
    // capability set — Dolphin emits a wide range of features and we
    // don't want to reject otherwise-valid modules here.
    let mut validator = naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::all(),
    );
    let info = validator.validate(&module).ok()?;

    naga::back::wgsl::write_string(&module, &info, naga::back::wgsl::WriterFlags::empty()).ok()
}
