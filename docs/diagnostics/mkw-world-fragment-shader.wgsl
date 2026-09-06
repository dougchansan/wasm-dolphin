struct type_15 {
 member: vec3<f32>,
 member_1: vec3<f32>,
 member_2: vec3<f32>,
 member_3: u32,
 member_4: vec4<f32>,
 member_5: vec4<f32>,
}

struct type_18 {
 member: vec4<f32>,
 member_1: vec4<f32>,
 member_2: i32,
 member_3: vec3<f32>,
 member_4: vec3<f32>,
 member_5: vec3<f32>,
 member_6: vec3<f32>,
 member_7: vec3<f32>,
 member_8: vec3<f32>,
 member_9: vec3<f32>,
 member_10: vec3<f32>,
 member_11: vec3<f32>,
 member_12: vec3<f32>,
 member_13: array<type_15, 8>,
 member_14: array<type_15, 8>,
 member_15: array<type_15, 8>,
 member_16: array<type_15, 8>,
 member_17: array<vec4<f32>, 2>,
 member_18: array<vec4<f32>, 2>,
 member_19: u32,
 member_20: u32,
 member_21: u32,
 member_22: u32,
}

struct type_20 {
 member: vec4<i32>,
 member_1: vec4<i32>,
}

struct type_30 {
 member: array<vec4<i32>, 4>,
 member_1: array<vec4<i32>, 4>,
 member_2: vec4<i32>,
 member_3: array<vec4<i32>, 8>,
 member_4: array<vec4<i32>, 2>,
 member_5: array<vec4<i32>, 2>,
 member_6: array<vec4<i32>, 6>,
 member_7: vec4<i32>,
 member_8: vec4<i32>,
 member_9: vec4<f32>,
 member_10: array<vec4<f32>, 3>,
 member_11: vec4<f32>,
 member_12: vec2<f32>,
 member_13: u32,
 member_14: u32,
 member_15: u32,
 member_16: u32,
 member_17: u32,
 member_18: u32,
 member_19: u32,
 member_20: u32,
 member_21: u32,
 member_22: u32,
 member_23: array<vec4<u32>, 16>,
 member_24: array<vec4<u32>, 8>,
 member_25: array<vec4<i32>, 32>,
 member_26: u32,
 member_27: u32,
 member_28: u32,
 member_29: u32,
 member_30: u32,
 member_31: u32,
 member_32: u32,
 member_33: u32,
 member_34: u32,
 member_35: u32,
}

@group(0) @binding(0) 
var<uniform> global: type_30;
@group(1) @binding(0) 
var global_1: texture_2d_array<f32>;
@group(1) @binding(8) 
var global_2: sampler;
var<private> global_3: vec4<f32>;
var<private> global_4: vec4<f32>;
var<private> global_5: vec4<f32>;
var<private> global_6: vec3<f32>;
var<private> global_7: vec4<f32>;
@group(1) @binding(1) 
var global_8: texture_2d_array<f32>;
@group(1) @binding(2) 
var global_9: texture_2d_array<f32>;
@group(1) @binding(3) 
var global_10: texture_2d_array<f32>;
@group(1) @binding(4) 
var global_11: texture_2d_array<f32>;
@group(1) @binding(5) 
var global_12: texture_2d_array<f32>;
@group(1) @binding(6) 
var global_13: texture_2d_array<f32>;
@group(1) @binding(7) 
var global_14: texture_2d_array<f32>;

fn dolphin_fn_0_(param_4: ptr<function, vec4<f32>>) -> vec4<i32> {
 let _e59 = (*param_4);
 return vec4<i32>(round(_e59));
}

fn dolphin_fn_1_(param_5: ptr<function, u32>) -> vec4<u32> {
 let _e59 = (*param_5);
 switch bitcast<i32>(_e59) {
 case 0: {
 let _e66 = global.member_24[0i];
 return _e66;
 }
 case 1: {
 let _e69 = global.member_24[1i];
 return _e69;
 }
 case 2: {
 let _e72 = global.member_24[2i];
 return _e72;
 }
 case 3: {
 let _e75 = global.member_24[3i];
 return _e75;
 }
 case 4: {
 let _e78 = global.member_24[4i];
 return _e78;
 }
 case 5: {
 let _e81 = global.member_24[5i];
 return _e81;
 }
 case 6: {
 let _e84 = global.member_24[6i];
 return _e84;
 }
 case 7: {
 let _e87 = global.member_24[7i];
 return _e87;
 }
 default: {
 let _e63 = global.member_24[0i];
 return _e63;
 }
 }
}

fn dolphin_fn_2_(param_6: ptr<function, u32>, param_7: texture_2d_array<f32>, param_8: sampler, param_9: ptr<function, vec2<i32>>, param_10: ptr<function, i32>) -> vec4<i32> {
 var local: f32;
 var local_1: f32;
 var local_2: vec3<f32>;
 var local_3: u32;
 var local_4: u32;
 var local_5: f32;
 var local_6: vec4<f32>;

 let _e70 = (*param_6);
 let _e74 = global.member_3[_e70][0u];
 local = f32((_e74 * 128i));
 let _e77 = (*param_6);
 let _e81 = global.member_3[_e77][1u];
 local_1 = f32((_e81 * 128i));
 let _e85 = (*param_9)[0u];
 let _e87 = local;
 let _e90 = (*param_9)[1u];
 let _e92 = local_1;
 let _e94 = (*param_10);
 local_2 = vec3<f32>((f32(_e85) / _e87), (f32(_e90) / _e92), f32(_e94));
 let _e97 = (*param_6);
 local_4 = _e97;
 let _e98 = dolphin_fn_1_((&local_4));
 local_3 = _e98.z;
 let _e100 = local_3;
 local_5 = (f32(extractBits(bitcast<i32>(_e100), bitcast<u32>(8i), bitcast<u32>(16i))) / 256f);
 let _e107 = local_2;
 let _e108 = local_5;
 let _e114 = textureSampleBias(param_7, param_8, vec2<f32>(_e107.x, _e107.y), i32(_e107.z), _e108);
 local_6 = (_e114 * 255f);
 let _e116 = dolphin_fn_0_((&local_6));
 return _e116;
}

fn dolphin_fn_3_(param_11: ptr<function, type_18>, param_12: ptr<function, type_20>) {
 var local_7: vec4<f32>;
 var local_8: vec4<f32>;
 var local_9: i32;
 var local_10: vec4<i32>;
 var local_11: vec4<i32>;
 var local_12: vec4<i32>;
 var local_13: vec4<i32>;
 var local_14: vec4<i32>;
 var local_15: vec4<i32>;
 var local_16: vec4<i32>;
 var local_17: vec4<i32>;
 var local_18: vec3<i32>;
 var local_19: vec3<i32>;
 var local_20: i32;
 var local_21: vec3<i32>;
 var local_22: vec2<i32>;
 var local_23: vec2<i32>;
 var local_24: vec4<i32>;
 var local_25: vec4<i32>;
 var local_26: vec4<i32>;
 var local_27: vec4<i32>;
 var local_28: vec2<i32>;
 var local_29: vec2<f32>;
 var local_30: vec2<i32>;
 var local_31: vec4<f32>;
 var local_32: u32;
 var local_33: vec2<i32>;
 var local_34: i32;

 let _e89 = (*param_11).member;
 local_7 = _e89;
 let _e91 = (*param_11).member_1;
 local_8 = _e91;
 let _e93 = (*param_11).member_2;
 local_9 = _e93;
 let _e96 = global.member[1i];
 local_10 = _e96;
 let _e99 = global.member[2i];
 local_11 = _e99;
 let _e102 = global.member[3i];
 local_12 = _e102;
 let _e105 = global.member[0i];
 local_13 = _e105;
 local_14 = vec4<i32>(0i, 0i, 0i, 0i);
 local_15 = vec4<i32>(0i, 0i, 0i, 0i);
 local_16 = vec4<i32>(0i, 0i, 0i, 0i);
 local_17 = vec4<i32>(0i, 0i, 0i, 0i);
 local_18 = vec3<i32>(1i, 256i, 0i);
 local_19 = vec3<i32>(1i, 256i, 65536i);
 local_20 = 0i;
 local_21 = vec3<i32>(0i, 0i, 0i);
 local_22 = vec2<i32>(0i, 0i);
 local_23 = vec2<i32>(0i, 0i);
 local_24 = vec4<i32>(0i, 0i, 0i, 0i);
 local_25 = vec4<i32>(0i, 0i, 0i, 0i);
 local_26 = vec4<i32>(0i, 0i, 0i, 0i);
 local_27 = vec4<i32>(0i, 0i, 0i, 0i);
 let _e108 = (*param_11).member_5[2u];
 if (_e108 == 0f) {
 let _e111 = (*param_11).member_5;
 local_29 = _e111.xy;
 } else {
 let _e114 = (*param_11).member_5;
 let _e118 = (*param_11).member_5[2u];
 local_29 = (_e114.xy / vec2(_e118));
 }
 let _e121 = local_29;
 let _e124 = global.member_3[0i];
 local_28 = vec2<i32>((_e121 * vec2<f32>((_e124.zw * vec2(128i)))));
 local_30 = vec2<i32>(0i, 0i);
 let _e132 = local_28[0u];
 local_22[0u] = _e132;
 let _e135 = local_28[1u];
 local_22[1u] = _e135;
 let _e137 = local_22;
 let _e138 = local_30;
 let _e139 = (_e137 + _e138);
 local_21[0u] = _e139.x;
 local_21[1u] = _e139.y;
 let _e144 = local_21;
 let _e151 = ((_e144.xy << bitcast<vec2<u32>>(vec2(8i))) >> bitcast<vec2<u32>>(vec2(8i)));
 local_21[0u] = _e151.x;
 local_21[1u] = _e151.y;
 let _e156 = local_7;
 local_31 = (_e156 * 255f);
 let _e158 = dolphin_fn_0_((&local_31));
 local_14 = _e158;
 local_32 = 0u;
 let _e159 = local_21;
 local_33 = _e159.xy;
 let _e161 = local_9;
 local_34 = _e161;
 let _e162 = dolphin_fn_2_((&local_32), global_1, global_2, (&local_33), (&local_34));
 local_15 = _e162;
 let _e163 = local_15;
 local_16 = _e163;
 let _e164 = local_14;
 let _e165 = _e164.xyz;
 local_24 = (vec4<i32>(_e165.x, _e165.y, _e165.z, 0i) & vec4<i32>(255i, 255i, 255i, 255i));
 let _e172 = local_16[3u];
 local_25 = (vec4<i32>(vec3<i32>(0i, 0i, 0i).x, vec3<i32>(0i, 0i, 0i).y, vec3<i32>(0i, 0i, 0i).z, _e172) & vec4<i32>(255i, 255i, 255i, 255i));
 let _e179 = local_14[3u];
 local_26 = (vec4<i32>(vec3<i32>(0i, 0i, 0i).x, vec3<i32>(0i, 0i, 0i).y, vec3<i32>(0i, 0i, 0i).z, _e179) & vec4<i32>(255i, 255i, 255i, 255i));
 let _e185 = local_16;
 let _e186 = _e185.xyz;
 local_27 = vec4<i32>(_e186.x, _e186.y, _e186.z, 0i);
 let _e191 = local_27;
 let _e193 = local_24;
 let _e198 = local_25;
 let _e200 = local_24;
 let _e203 = local_26;
 let _e205 = local_26;
 let _e219 = clamp((_e191.xyz + ((((_e193.xyz << bitcast<vec3<u32>>(vec3(8i))) + ((_e198.xyz - _e200.xyz) * (_e203.xyz + (_e205.xyz >> bitcast<vec3<u32>>(vec3(7i)))))) + vec3(128i)) >> bitcast<vec3<u32>>(vec3(8i)))), vec3<i32>(0i, 0i, 0i), vec3<i32>(255i, 255i, 255i));
 local_13[0u] = _e219.x;
 local_13[1u] = _e219.y;
 local_13[2u] = _e219.z;
 let _e227 = local_27[3u];
 let _e229 = local_24[3u];
 let _e233 = local_25[3u];
 let _e235 = local_24[3u];
 let _e238 = local_26[3u];
 let _e240 = local_26[3u];
 local_13[3u] = clamp((_e227 + ((((_e229 << bitcast<u32>(8i)) + ((_e233 - _e235) * (_e238 + (_e240 >> bitcast<u32>(7i))))) + 128i) >> bitcast<u32>(8i))), 0i, 255i);
 let _e252 = local_15;
 (*param_12).member_1 = _e252;
 let _e254 = local_13;
 (*param_12).member = _e254;
 return;
}

fn dolphin_fn_4_(param_13: ptr<function, type_18>, param_14: ptr<function, type_20>) {
 var local_35: type_18;
 var local_36: type_20;

 let _e62 = (*param_13);
 local_35 = _e62;
 dolphin_fn_3_((&local_35), (&local_36));
 let _e63 = local_36;
 (*param_14) = _e63;
 return;
}

fn dolphin_fn_5_() {
 var local_37: vec4<f32>;
 var local_38: i32;
 var local_39: type_18;
 var local_40: type_20;
 var local_41: type_18;
 var local_42: type_20;
 var local_43: vec4<i32>;
 var local_44: i32;
 var phi_452_: bool;

 let _e66 = global_3;
 local_37 = _e66;
 local_38 = 0i;
 let _e67 = global_4;
 local_39.member = _e67;
 let _e69 = global_5;
 local_39.member_1 = _e69;
 let _e71 = local_38;
 local_39.member_2 = _e71;
 local_39.member_3 = vec3<f32>(0f, 0f, 0f);
 local_39.member_4 = vec3<f32>(0f, 0f, 0f);
 let _e75 = global_6;
 local_39.member_5 = _e75;
 local_39.member_6 = vec3<f32>(0f, 0f, 0f);
 local_39.member_7 = vec3<f32>(0f, 0f, 0f);
 local_39.member_8 = vec3<f32>(0f, 0f, 0f);
 local_39.member_9 = vec3<f32>(0f, 0f, 0f);
 local_39.member_10 = vec3<f32>(0f, 0f, 0f);
 local_39.member_11 = vec3<f32>(0f, 0f, 0f);
 local_39.member_12 = vec3<f32>(0f, 0f, 0f);
 let _e84 = local_39;
 local_41 = _e84;
 dolphin_fn_4_((&local_41), (&local_42));
 let _e85 = local_42;
 local_40 = _e85;
 let _e87 = local_40.member;
 local_43 = (_e87 & vec4(255i));
 let _e91 = local_43[3u];
 let _e94 = global.member_2[0u];
 let _e95 = (_e91 >= _e94);
 phi_452_ = _e95;
 if _e95 {
 let _e97 = local_43[3u];
 let _e100 = global.member_2[1u];
 phi_452_ = (_e97 <= _e100);
 }
 let _e103 = phi_452_;
 if !(_e103) {
 global_7 = vec4<f32>(0f, 0f, 0f, 0f);
 discard;
 }
 let _e106 = local_43[3u];
 if (_e106 == 1i) {
 local_43[3u] = 0i;
 }
 let _e110 = local_37[2u];
 local_44 = i32((_e110 * 16777216f));
 let _e113 = local_44;
 local_44 = clamp(_e113, 0i, 16777215i);
 let _e115 = local_43;
 let _e119 = (vec3<f32>(_e115.xyz) / vec3(255f));
 global_7[0u] = _e119.x;
 global_7[1u] = _e119.y;
 global_7[2u] = _e119.z;
 let _e128 = global.member_2[3u];
 global_7[3u] = (f32((_e128 >> bitcast<u32>(2i))) / 63f);
 return;
}

@fragment 
fn main(@builtin(position) param: vec4<f32>, @location(0) param_1: vec4<f32>, @location(1) param_2: vec4<f32>, @location(2) param_3: vec3<f32>) -> @location(0) vec4<f32> {
 global_3 = param;
 global_4 = param_1;
 global_5 = param_2;
 global_6 = param_3;
 dolphin_fn_5_();
 let _e9 = global_7;
 return _e9;
}
