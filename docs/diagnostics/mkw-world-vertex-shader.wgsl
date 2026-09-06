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

struct type_38 {
 member: vec4<f32>,
 member_1: vec4<f32>,
 member_2: vec4<f32>,
 member_3: vec3<f32>,
}

struct type_42 {
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
var<private> global_2: vec4<f32>;
var<private> global_3: vec3<f32>;
var<private> global_4: vec3<f32>;
var<private> global_5: vec4<f32>;
var<private> global_6: vec4<f32>;
var<private> global_7: type_42 = type_42(vec4<f32>(0f, 0f, 0f, 1f), 1f, array<f32, 1>(), array<f32, 1>());
var<private> global_8: vec2<f32>;

fn dolphin_fn_0_(param_4: ptr<function, vec4<f32>>) -> vec3<f32> {
 var local: vec3<f32>;
 var local_1: vec4<f32>;
 var local_2: vec4<f32>;
 var local_3: vec4<f32>;

 let _e54 = (*param_4);
 let _e57 = global.member_9[0i];
 let _e59 = (*param_4);
 let _e62 = global.member_9[1i];
 let _e64 = (*param_4);
 let _e67 = global.member_9[2i];
 local = vec3<f32>(dot(_e54, _e57), dot(_e59, _e62), dot(_e64, _e67));
 let _e72 = global.member_12[0i];
 local_1 = _e72;
 let _e75 = global.member_12[1i];
 local_2 = _e75;
 let _e78 = global.member_12[2i];
 local_3 = _e78;
 let _e79 = local;
 local = normalize(_e79);
 let _e81 = local_1;
 let _e83 = local;
 let _e86 = local_1[3u];
 let _e88 = local_2;
 let _e90 = local;
 let _e93 = local_2[3u];
 let _e95 = local_3;
 let _e97 = local;
 let _e100 = local_3[3u];
 local = vec3<f32>((dot(_e81.xyz, _e83) + _e86), (dot(_e88.xyz, _e90) + _e93), (dot(_e95.xyz, _e97) + _e100));
 let _e104 = local[2u];
 if (_e104 == 0f) {
 let _e106 = local;
 let _e110 = clamp((_e106.xy / vec2(2f)), vec2<f32>(-1f, -1f), vec2<f32>(1f, 1f));
 local[0u] = _e110.x;
 local[1u] = _e110.y;
 }
 let _e115 = local;
 return _e115;
}

fn dolphin_fn_1_(param_5: ptr<function, vec4<f32>>, param_6: ptr<function, vec3<f32>>, param_7: ptr<function, vec3<f32>>) -> vec4<f32> {
 var local_4: vec4<i32>;
 var local_5: vec4<i32>;

 let _e56 = global.member_7[3i];
 local_4 = _e56;
 local_5 = vec4<i32>(255i, 255i, 255i, 255i);
 local_5[3u] = 255i;
 let _e58 = local_5;
 local_5 = clamp(_e58, vec4(0i), vec4(255i));
 let _e62 = local_4;
 let _e63 = local_5;
 let _e64 = local_5;
 return (vec4<f32>(((_e62 * (_e63 + (_e64 >> bitcast<vec4<u32>>(vec4(7i))))) >> bitcast<vec4<u32>>(vec4(8i)))) / vec4(255f));
}

fn dolphin_fn_2_(param_8: ptr<function, vec4<f32>>, param_9: ptr<function, vec3<f32>>, param_10: ptr<function, vec3<f32>>) -> vec4<f32> {
 var local_6: vec4<i32>;
 var local_7: vec4<i32>;

 let _e54 = (*param_8);
 local_6 = vec4<i32>(round((_e54 * 255f)));
 local_7 = vec4<i32>(255i, 255i, 255i, 255i);
 local_7[3u] = 255i;
 let _e59 = local_7;
 local_7 = clamp(_e59, vec4(0i), vec4(255i));
 let _e63 = local_6;
 let _e64 = local_7;
 let _e65 = local_7;
 return (vec4<f32>(((_e63 * (_e64 + (_e65 >> bitcast<vec4<u32>>(vec4(7i))))) >> bitcast<vec4<u32>>(vec4(8i)))) / vec4(255f));
}

fn dolphin_fn_3_() -> mat3x3<f32> {
 var local_8: mat3x3<f32>;

 let _e52 = global.member_5[3i];
 local_8[0] = _e52.xyz;
 let _e57 = global.member_5[4i];
 local_8[1] = _e57.xyz;
 let _e62 = global.member_5[5i];
 local_8[2] = _e62.xyz;
 let _e65 = local_8;
 return _e65;
}

fn dolphin_fn_4_() -> mat3x4<f32> {
 var local_9: mat3x4<f32>;

 let _e52 = global.member_5[0i];
 local_9[0] = _e52;
 let _e56 = global.member_5[1i];
 local_9[1] = _e56;
 let _e60 = global.member_5[2i];
 local_9[2] = _e60;
 let _e62 = local_9;
 return _e62;
}

fn dolphin_fn_5_(param_11: ptr<function, type_7>, param_12: ptr<function, type_9>) {
 var local_10: vec4<f32>;
 var local_11: vec4<f32>;
 var local_12: vec3<f32>;
 var local_13: vec3<f32>;
 var local_14: vec4<f32>;
 var local_15: vec4<f32>;
 var local_16: vec3<f32>;
 var local_17: vec3<f32>;
 var local_18: vec4<f32>;

 let _e61 = (*param_11).member_2;
 let _e62 = dolphin_fn_4_();
 let _e63 = (_e61 * _e62);
 (*param_12).member_2 = vec4<f32>(_e63.x, _e63.y, _e63.z, 1f);
 let _e70 = (*param_11).member_3;
 let _e71 = dolphin_fn_3_();
 (*param_12).member_3 = normalize((_e70 * _e71));
 let _e76 = (*param_11).member;
 local_11 = _e76;
 let _e78 = (*param_12).member_2;
 local_12 = _e78.xyz;
 let _e81 = (*param_12).member_3;
 local_13 = _e81;
 let _e82 = dolphin_fn_2_((&local_11), (&local_12), (&local_13));
 local_10 = _e82;
 let _e83 = local_10;
 (*param_12).member = _e83;
 let _e86 = (*param_11).member_1;
 local_15 = _e86;
 let _e88 = (*param_12).member_2;
 local_16 = _e88.xyz;
 let _e91 = (*param_12).member_3;
 local_17 = _e91;
 let _e92 = dolphin_fn_1_((&local_15), (&local_16), (&local_17));
 local_14 = _e92;
 let _e93 = local_14;
 (*param_12).member_1 = _e93;
 (*param_12).member_1 = vec4<f32>(0f, 0f, 0f, 0f);
 let _e97 = (*param_11).member_6;
 local_18 = _e97;
 let _e98 = dolphin_fn_0_((&local_18));
 (*param_12).member_4 = _e98;
 (*param_12).member_5 = vec3<f32>(0f, 0f, 0f);
 (*param_12).member_6 = vec3<f32>(0f, 0f, 0f);
 (*param_12).member_7 = vec3<f32>(0f, 0f, 0f);
 (*param_12).member_8 = vec3<f32>(0f, 0f, 0f);
 (*param_12).member_9 = vec3<f32>(0f, 0f, 0f);
 (*param_12).member_10 = vec3<f32>(0f, 0f, 0f);
 (*param_12).member_11 = vec3<f32>(0f, 0f, 0f);
 return;
}

fn dolphin_fn_6_(param_13: ptr<function, type_7>, param_14: ptr<function, type_9>) {
 var local_19: type_7;
 var local_20: type_9;

 let _e53 = (*param_13);
 local_19 = _e53;
 dolphin_fn_5_((&local_19), (&local_20));
 let _e54 = local_20;
 (*param_14) = _e54;
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
 var local_28: type_38;

 let _e57 = global_1;
 local_21 = _e57;
 let _e59 = global.member_4;
 local_22 = _e59;
 let _e60 = local_21;
 local_23.member = _e60;
 let _e62 = local_22;
 local_23.member_1 = _e62;
 let _e64 = global_2;
 local_23.member_2 = _e64;
 let _e66 = global_3;
 local_23.member_3 = _e66;
 let _e69 = global.member_18;
 local_23.member_4 = _e69.xyz;
 let _e73 = global.member_17;
 local_23.member_5 = _e73.xyz;
 local_24 = vec4<f32>(0f, 0f, 1f, 1f);
 let _e76 = global_3;
 local_24[0u] = _e76.x;
 local_24[1u] = _e76.y;
 local_24[2u] = _e76.z;
 let _e84 = local_24[0u];
 let _e86 = local_24[0u];
 if (_e84 != _e86) {
 local_24[0u] = 1f;
 }
 let _e90 = local_24[1u];
 let _e92 = local_24[1u];
 if (_e90 != _e92) {
 local_24[1u] = 1f;
 }
 let _e96 = local_24[2u];
 let _e98 = local_24[2u];
 if (_e96 != _e98) {
 local_24[2u] = 1f;
 }
 let _e101 = local_24;
 local_23.member_6 = _e101;
 local_23.member_7 = vec4<f32>(0f, 0f, 0f, 0f);
 local_23.member_8 = vec4<f32>(0f, 0f, 0f, 0f);
 local_23.member_9 = vec4<f32>(0f, 0f, 0f, 0f);
 local_23.member_10 = vec4<f32>(0f, 0f, 0f, 0f);
 local_23.member_11 = vec4<f32>(0f, 0f, 0f, 0f);
 local_23.member_12 = vec4<f32>(0f, 0f, 0f, 0f);
 local_23.member_13 = vec4<f32>(0f, 0f, 0f, 0f);
 let _e110 = local_23;
 local_26 = _e110;
 dolphin_fn_6_((&local_26), (&local_27));
 let _e111 = local_27;
 local_25 = _e111;
 let _e114 = global.member_6[0i];
 let _e116 = local_25.member_2;
 let _e120 = global.member_6[1i];
 let _e122 = local_25.member_2;
 let _e126 = global.member_6[2i];
 let _e128 = local_25.member_2;
 let _e132 = global.member_6[3i];
 let _e134 = local_25.member_2;
 local_28.member = vec4<f32>(dot(_e114, _e116), dot(_e120, _e122), dot(_e126, _e128), dot(_e132, _e134));
 let _e139 = local_25.member_4;
 local_28.member_3 = _e139;
 let _e142 = local_25.member;
 local_28.member_1 = _e142;
 let _e145 = local_25.member_1;
 local_28.member_2 = _e145;
 let _e149 = local_28.member[2u];
 local_28.member[2u] = (_e149 * 0.9999999f);
 let _e155 = local_28.member[3u];
 let _e158 = global.member_13[3u];
 let _e162 = local_28.member[2u];
 let _e165 = global.member_13[2u];
 local_28.member[2u] = ((_e155 * _e158) - (_e162 * _e165));
 let _e171 = global.member_13;
 let _e176 = local_28.member;
 let _e178 = (_e176.xy * sign((_e171.xy * vec2<f32>(1f, -1f))));
 local_28.member[0u] = _e178.x;
 local_28.member[1u] = _e178.y;
 let _e186 = local_28.member;
 let _e190 = local_28.member[3u];
 let _e192 = global.member_13;
 let _e195 = (_e186.xy - (_e192.xy * _e190));
 local_28.member[0u] = _e195.x;
 local_28.member[1u] = _e195.y;
 let _e203 = local_28.member_3;
 global_4 = _e203;
 let _e205 = local_28.member_1;
 global_5 = _e205;
 let _e207 = local_28.member_2;
 global_6 = _e207;
 let _e210 = local_28.member[0u];
 let _e213 = local_28.member[1u];
 let _e217 = local_28.member[2u];
 let _e220 = local_28.member[3u];
 global_7.member = vec4<f32>(_e210, -(_e213), _e217, _e220);
 return;
}

@vertex 
fn main(@location(5) param: vec4<f32>, @location(0) param_1: vec4<f32>, @location(2) param_2: vec3<f32>, @location(8) param_3: vec2<f32>) -> VertexOutput {
 global_1 = param;
 global_2 = param_1;
 global_3 = param_2;
 global_8 = param_3;
 dolphin_fn_7_();
 let _e14 = global_7.member.y;
 global_7.member.y = -(_e14);
 let _e16 = global_4;
 let _e17 = global_5;
 let _e18 = global_6;
 let _e19 = global_7.member;
 return VertexOutput(_e16, _e17, _e18, _e19);
}
