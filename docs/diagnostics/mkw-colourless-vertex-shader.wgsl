struct type_7 {
 member: vec4<f32>,
 member_1: vec4<f32>,
 member_2: vec4<f32>,
 member_3: vec3<f32>,
 member_4: vec3<f32>,
 member_5: vec3<f32>,
 member_6: vec4<f32>,
 member_7: vec4<f32>,
 member_8: vec4<f32>,
 member_9: vec4<f32>,
 member_10: vec4<f32>,
 member_11: vec4<f32>,
 member_12: vec4<f32>,
 member_13: vec4<f32>,
}

struct type_9 {
 member: vec4<f32>,
 member_1: vec4<f32>,
 member_2: vec4<f32>,
 member_3: vec3<f32>,
 member_4: vec3<f32>,
 member_5: vec3<f32>,
 member_6: vec3<f32>,
 member_7: vec3<f32>,
 member_8: vec3<f32>,
 member_9: vec3<f32>,
 member_10: vec3<f32>,
 member_11: vec3<f32>,
}

struct type_19 {
 member: vec4<i32>,
 member_1: vec4<f32>,
 member_2: vec4<f32>,
 member_3: vec4<f32>,
 member_4: vec4<f32>,
}

struct type_28 {
 member: u32,
 member_1: u32,
 member_2: u32,
 member_3: u32,
 member_4: vec4<f32>,
 member_5: array<vec4<f32>, 6>,
 member_6: array<vec4<f32>, 4>,
 member_7: array<vec4<i32>, 4>,
 member_8: array<type_19, 8>,
 member_9: array<vec4<f32>, 24>,
 member_10: array<vec4<f32>, 64>,
 member_11: array<vec4<f32>, 32>,
 member_12: array<vec4<f32>, 64>,
 member_13: vec4<f32>,
 member_14: vec2<f32>,
 member_15: array<vec4<u32>, 8>,
 member_16: vec4<f32>,
 member_17: vec4<f32>,
 member_18: vec4<f32>,
 member_19: u32,
 member_20: u32,
 member_21: u32,
 member_22: u32,
 member_23: u32,
 member_24: u32,
 member_25: u32,
 member_26: u32,
 member_27: array<vec4<u32>, 2>,
}

struct type_39 {
 member: vec4<f32>,
 member_1: vec4<f32>,
 member_2: vec4<f32>,
 member_3: vec3<f32>,
}

struct type_44 {
 @builtin(position) member: vec4<f32>,
 member_1: f32,
 member_2: array<f32, 1>,
 member_3: array<f32, 1>,
}

struct VertexOutput {
 @location(2) member: vec3<f32>,
 @location(0) member_1: vec4<f32>,
 @location(1) member_2: vec4<f32>,
 @builtin(position) member_3: vec4<f32>,
}

@group(0) @binding(1) 
var<uniform> global: type_28;
var<private> global_1: vec4<f32>;
var<private> global_2: vec2<f32>;
var<private> global_3: vec3<f32>;
var<private> global_4: vec4<f32>;
var<private> global_5: vec4<f32>;
var<private> global_6: type_44 = type_44(vec4<f32>(0f, 0f, 0f, 1f), 1f, array<f32, 1>(), array<f32, 1>());

fn dolphin_fn_0_(param_2: ptr<function, vec4<f32>>) -> vec3<f32> {
 var local: vec3<f32>;
 var local_1: vec4<f32>;
 var local_2: vec4<f32>;
 var local_3: vec4<f32>;

 let _e56 = (*param_2);
 let _e59 = global.member_9[0i];
 let _e61 = (*param_2);
 let _e64 = global.member_9[1i];
 local = vec3<f32>(dot(_e56, _e59), dot(_e61, _e64), 1f);
 let _e69 = global.member_12[61i];
 local_1 = _e69;
 let _e72 = global.member_12[62i];
 local_2 = _e72;
 let _e75 = global.member_12[63i];
 local_3 = _e75;
 let _e76 = local_1;
 let _e78 = local;
 let _e81 = local_1[3u];
 let _e83 = local_2;
 let _e85 = local;
 let _e88 = local_2[3u];
 let _e90 = local_3;
 let _e92 = local;
 let _e95 = local_3[3u];
 local = vec3<f32>((dot(_e76.xyz, _e78) + _e81), (dot(_e83.xyz, _e85) + _e88), (dot(_e90.xyz, _e92) + _e95));
 let _e99 = local[2u];
 if (_e99 == 0f) {
 let _e101 = local;
 let _e105 = clamp((_e101.xy / vec2(2f)), vec2<f32>(-1f, -1f), vec2<f32>(1f, 1f));
 local[0u] = _e105.x;
 local[1u] = _e105.y;
 }
 let _e110 = local;
 return _e110;
}

fn dolphin_fn_1_(param_3: ptr<function, vec4<f32>>, param_4: ptr<function, vec3<f32>>, param_5: ptr<function, vec3<f32>>) -> vec4<f32> {
 var local_4: vec4<i32>;
 var local_5: vec4<i32>;

 let _e58 = global.member_7[3i];
 local_4 = _e58;
 local_5 = vec4<i32>(255i, 255i, 255i, 255i);
 local_5[3u] = 255i;
 let _e60 = local_5;
 local_5 = clamp(_e60, vec4(0i), vec4(255i));
 let _e64 = local_4;
 let _e65 = local_5;
 let _e66 = local_5;
 return (vec4<f32>(((_e64 * (_e65 + (_e66 >> bitcast<vec4<u32>>(vec4(7i))))) >> bitcast<vec4<u32>>(vec4(8i)))) / vec4(255f));
}

fn dolphin_fn_2_(param_6: ptr<function, vec4<f32>>, param_7: ptr<function, vec3<f32>>, param_8: ptr<function, vec3<f32>>) -> vec4<f32> {
 var local_6: vec4<i32>;
 var local_7: vec4<i32>;

 let _e56 = (*param_6);
 local_6 = vec4<i32>(round((_e56 * 255f)));
 local_7 = vec4<i32>(255i, 255i, 255i, 255i);
 local_7[3u] = 255i;
 let _e61 = local_7;
 local_7 = clamp(_e61, vec4(0i), vec4(255i));
 let _e65 = local_6;
 let _e66 = local_7;
 let _e67 = local_7;
 return (vec4<f32>(((_e65 * (_e66 + (_e67 >> bitcast<vec4<u32>>(vec4(7i))))) >> bitcast<vec4<u32>>(vec4(8i)))) / vec4(255f));
}

fn dolphin_fn_3_() -> mat3x3<f32> {
 var local_8: mat3x3<f32>;

 let _e54 = global.member_5[3i];
 local_8[0] = _e54.xyz;
 let _e59 = global.member_5[4i];
 local_8[1] = _e59.xyz;
 let _e64 = global.member_5[5i];
 local_8[2] = _e64.xyz;
 let _e67 = local_8;
 return _e67;
}

fn dolphin_fn_4_() -> mat3x4<f32> {
 var local_9: mat3x4<f32>;

 let _e54 = global.member_5[0i];
 local_9[0] = _e54;
 let _e58 = global.member_5[1i];
 local_9[1] = _e58;
 let _e62 = global.member_5[2i];
 local_9[2] = _e62;
 let _e64 = local_9;
 return _e64;
}

fn dolphin_fn_5_(param_9: ptr<function, type_7>, param_10: ptr<function, type_9>) {
 var local_10: vec4<f32>;
 var local_11: vec4<f32>;
 var local_12: vec3<f32>;
 var local_13: vec3<f32>;
 var local_14: vec4<f32>;
 var local_15: vec4<f32>;
 var local_16: vec3<f32>;
 var local_17: vec3<f32>;
 var local_18: vec4<f32>;

 let _e63 = (*param_9).member_2;
 let _e64 = dolphin_fn_4_();
 let _e65 = (_e63 * _e64);
 (*param_10).member_2 = vec4<f32>(_e65.x, _e65.y, _e65.z, 1f);
 let _e72 = (*param_9).member_3;
 let _e73 = dolphin_fn_3_();
 (*param_10).member_3 = normalize((_e72 * _e73));
 let _e78 = (*param_9).member;
 local_11 = _e78;
 let _e80 = (*param_10).member_2;
 local_12 = _e80.xyz;
 let _e83 = (*param_10).member_3;
 local_13 = _e83;
 let _e84 = dolphin_fn_2_((&local_11), (&local_12), (&local_13));
 local_10 = _e84;
 let _e85 = local_10;
 (*param_10).member = _e85;
 let _e88 = (*param_9).member_1;
 local_15 = _e88;
 let _e90 = (*param_10).member_2;
 local_16 = _e90.xyz;
 let _e93 = (*param_10).member_3;
 local_17 = _e93;
 let _e94 = dolphin_fn_1_((&local_15), (&local_16), (&local_17));
 local_14 = _e94;
 let _e95 = local_14;
 (*param_10).member_1 = _e95;
 (*param_10).member = vec4<f32>(0f, 0f, 0f, 0f);
 (*param_10).member_1 = vec4<f32>(0f, 0f, 0f, 0f);
 let _e100 = (*param_9).member_6;
 local_18 = _e100;
 let _e101 = dolphin_fn_0_((&local_18));
 (*param_10).member_4 = _e101;
 (*param_10).member_5 = vec3<f32>(0f, 0f, 0f);
 (*param_10).member_6 = vec3<f32>(0f, 0f, 0f);
 (*param_10).member_7 = vec3<f32>(0f, 0f, 0f);
 (*param_10).member_8 = vec3<f32>(0f, 0f, 0f);
 (*param_10).member_9 = vec3<f32>(0f, 0f, 0f);
 (*param_10).member_10 = vec3<f32>(0f, 0f, 0f);
 (*param_10).member_11 = vec3<f32>(0f, 0f, 0f);
 return;
}

fn dolphin_fn_6_(param_11: ptr<function, type_7>, param_12: ptr<function, type_9>) {
 var local_19: type_7;
 var local_20: type_9;

 let _e55 = (*param_11);
 local_19 = _e55;
 dolphin_fn_5_((&local_19), (&local_20));
 let _e56 = local_20;
 (*param_12) = _e56;
 return;
}

fn dolphin_fn_7_() {
 var local_21: vec4<f32>;
 var local_22: vec4<f32>;
 var local_23: type_7;
 var local_24: vec4<f32>;
 var local_25: type_9;
 var local_26: type_7;
 var local_27: type_9;
 var local_28: type_39;

 let _e60 = global.member_4;
 local_21 = _e60;
 let _e62 = global.member_4;
 local_22 = _e62;
 let _e63 = local_21;
 local_23.member = _e63;
 let _e65 = local_22;
 local_23.member_1 = _e65;
 let _e67 = global_1;
 local_23.member_2 = _e67;
 let _e70 = global.member_16;
 local_23.member_3 = _e70.xyz;
 let _e74 = global.member_18;
 local_23.member_4 = _e74.xyz;
 let _e78 = global.member_17;
 local_23.member_5 = _e78.xyz;
 local_24 = vec4<f32>(0f, 0f, 1f, 1f);
 let _e82 = global_2[0u];
 let _e84 = global_2[1u];
 local_24 = vec4<f32>(_e82, _e84, 1f, 1f);
 local_24[2u] = 1f;
 let _e88 = local_24[0u];
 let _e90 = local_24[0u];
 if (_e88 != _e90) {
 local_24[0u] = 1f;
 }
 let _e94 = local_24[1u];
 let _e96 = local_24[1u];
 if (_e94 != _e96) {
 local_24[1u] = 1f;
 }
 let _e100 = local_24[2u];
 let _e102 = local_24[2u];
 if (_e100 != _e102) {
 local_24[2u] = 1f;
 }
 let _e105 = local_24;
 local_23.member_6 = _e105;
 local_23.member_7 = vec4<f32>(0f, 0f, 0f, 0f);
 local_23.member_8 = vec4<f32>(0f, 0f, 0f, 0f);
 local_23.member_9 = vec4<f32>(0f, 0f, 0f, 0f);
 local_23.member_10 = vec4<f32>(0f, 0f, 0f, 0f);
 local_23.member_11 = vec4<f32>(0f, 0f, 0f, 0f);
 local_23.member_12 = vec4<f32>(0f, 0f, 0f, 0f);
 local_23.member_13 = vec4<f32>(0f, 0f, 0f, 0f);
 let _e114 = local_23;
 local_26 = _e114;
 dolphin_fn_6_((&local_26), (&local_27));
 let _e115 = local_27;
 local_25 = _e115;
 let _e118 = global.member_6[0i];
 let _e120 = local_25.member_2;
 let _e124 = global.member_6[1i];
 let _e126 = local_25.member_2;
 let _e130 = global.member_6[2i];
 let _e132 = local_25.member_2;
 let _e136 = global.member_6[3i];
 let _e138 = local_25.member_2;
 local_28.member = vec4<f32>(dot(_e118, _e120), dot(_e124, _e126), dot(_e130, _e132), dot(_e136, _e138));
 let _e143 = local_25.member_4;
 local_28.member_3 = _e143;
 let _e146 = local_25.member;
 local_28.member_1 = _e146;
 let _e149 = local_25.member_1;
 local_28.member_2 = _e149;
 let _e153 = local_28.member[2u];
 local_28.member[2u] = (_e153 * 0.9999999f);
 let _e159 = local_28.member[3u];
 let _e162 = global.member_13[3u];
 let _e166 = local_28.member[2u];
 let _e169 = global.member_13[2u];
 local_28.member[2u] = ((_e159 * _e162) - (_e166 * _e169));
 let _e175 = global.member_13;
 let _e180 = local_28.member;
 let _e182 = (_e180.xy * sign((_e175.xy * vec2<f32>(1f, -1f))));
 local_28.member[0u] = _e182.x;
 local_28.member[1u] = _e182.y;
 let _e190 = local_28.member;
 let _e194 = local_28.member[3u];
 let _e196 = global.member_13;
 let _e199 = (_e190.xy - (_e196.xy * _e194));
 local_28.member[0u] = _e199.x;
 local_28.member[1u] = _e199.y;
 let _e207 = local_28.member_3;
 global_3 = _e207;
 let _e209 = local_28.member_1;
 global_4 = _e209;
 let _e211 = local_28.member_2;
 global_5 = _e211;
 let _e214 = local_28.member[0u];
 let _e217 = local_28.member[1u];
 let _e221 = local_28.member[2u];
 let _e224 = local_28.member[3u];
 global_6.member = vec4<f32>(_e214, -(_e217), _e221, _e224);
 return;
}

@vertex 
fn main(@location(0) param: vec4<f32>, @location(8) param_1: vec2<f32>) -> VertexOutput {
 global_1 = param;
 global_2 = param_1;
 dolphin_fn_7_();
 let _e10 = global_6.member.y;
 global_6.member.y = -(_e10);
 let _e12 = global_3;
 let _e13 = global_4;
 let _e14 = global_5;
 let _e15 = global_6.member;
 return VertexOutput(_e12, _e13, _e14, _e15);
}
