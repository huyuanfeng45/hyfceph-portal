#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createDecipheriv, createHash, getCiphers } from 'node:crypto';
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { curveCatmullRom, curveCatmullRomClosed, line as svgLine } from 'd3-shape';
import { TOOTH_TEMPLATE_DATA } from './hyfceph-web-tooth-templates.mjs';

const DEFAULT_PAGE_URL = 'https://pd.aiyayi.com/latera/';
const DEFAULT_PORTAL_BASE_URL = 'https://hyfceph.52ortho.com/';
const DEFAULT_CLIENT_ID = 'e5cd7e4891bf95d1d19206ce24a7b32e';
const DEFAULT_X_APP_KEY = '3b939dfeb3c6d41c5de9298c6afc2db1';
const DEFAULT_ALGORITHM_NAME = 'ceph_keypoints';
const GA_HOST_MAP = new Set(['pd-ga.waveatp.com', 'pdmgr-ga.waveatp.com']);
const SHARE_DES_KEY = 'askldjqwozx';
const SHARE_DES_KEY_BYTES = Buffer.from(SHARE_DES_KEY.slice(0, 8), 'utf8');
const LANDMARK_ALIAS_MAP = new Map([
  ['s', 'S'],
  ['n', 'N'],
  ['na', 'N'],
  ['a', 'A'],
  ['b', 'B'],
  ['go', 'Go'],
  ['gn', 'Gn'],
  ['me', 'Me'],
  ['po', 'Po'],
  ['or', 'Or'],
  ['u1', 'U1T'],
  ['u1t', 'U1T'],
  ['u1a', 'U1R'],
  ['u1r', 'U1R'],
  ['l1', 'L1T'],
  ['l1t', 'L1T'],
  ['l1a', 'L1R'],
  ['l1r', 'L1R'],
]);
const METRIC_DEFINITIONS = {
  SNA: {
    label: '上颌相对于前颅底的前后位置',
    reference: '参考: 82° ± 2°',
    normalMin: 80,
    normalMax: 84,
    requiredKeys: ['S', 'N', 'A'],
  },
  SNB: {
    label: '下颌相对于前颅底的前后位置',
    reference: '参考: 79° ± 2°',
    normalMin: 77,
    normalMax: 81,
    requiredKeys: ['S', 'N', 'B'],
  },
  ANB: {
    label: '上下颌骨前后关系',
    reference: '参考: 2.7° ± 2°',
    normalMin: 0.7,
    normalMax: 4.7,
    requiredKeys: ['S', 'N', 'A', 'B'],
  },
  'GoGn-SN': {
    label: '下颌平面对前颅底平面的倾角',
    reference: '参考: 32° ± 4°',
    normalMin: 28,
    normalMax: 36,
    requiredKeys: ['Go', 'Gn', 'S', 'N'],
  },
  FMA: {
    label: '下颌平面对 FH 平面的角度',
    reference: '参考: 25° ± 4°',
    normalMin: 21,
    normalMax: 29,
    requiredKeys: ['Po', 'Or', 'Go', 'Me'],
  },
  'U1-SN': {
    label: '上中切牙相对于前颅底平面的倾角',
    reference: '参考: 102° ± 2°',
    normalMin: 100,
    normalMax: 104,
    requiredKeys: ['U1R', 'U1T', 'S', 'N'],
  },
  IMPA: {
    label: '下中切牙相对于下颌平面的倾角',
    reference: '参考: 90° ± 5°',
    normalMin: 85,
    normalMax: 95,
    requiredKeys: ['L1R', 'L1T', 'Go', 'Me'],
  },
};
const METRIC_ORDER = ['SNA', 'SNB', 'ANB', 'GoGn-SN', 'FMA', 'U1-SN', 'IMPA'];
const PRIMARY_LANDMARK_KEYS = new Set(
  Object.values(METRIC_DEFINITIONS).flatMap((definition) => definition.requiredKeys),
);
const FRAMEWORK_CHOICES = ['Downs', 'Steiner', '北大分析法', 'ABO', 'Ricketts', 'Tweed', 'McNamara', 'Jarabak'];
const RICKETTS_CONTOUR_KEYS = ['Tpl', 'Go', 'Rp', 'Man3', 'Ar', 'Pcd', 'Co', 'Go13', 'Go12', 'R3', 'Lj5', 'Lj4', 'Lj3', 'J'];
const WEB_FRAMEWORK_DATA = [
  {
    code: 'downs',
    label: 'Downs',
    items: [
      ['FH-NPo', 'FH-NPo', 85.5, 3],
      ['NA-APo', 'NA-APo', 6.5, 4.5],
      ['AB-NPo', 'AB-NPo', -5.4, 2.3],
      ['FH-MP', 'FH-MP', 27.9, 4.4],
      ['SGn-FH', 'SGn-FH', 63.5, 3.2],
      ['OP-FH', 'OP-FH', 14, 3.8],
      ['U1-L1', 'U1-L1', 126.9, 8.5],
      ['L1-OP', 'L1-OP', 109, 5.6],
      ['U1-APo(mm)', 'U1-APo(mm)', 6.7, 2],
      ['L1-MP', 'L1-MP', 95, 6.5],
    ],
  },
  {
    code: 'steiner',
    label: 'Steiner',
    items: [
      ['SNA', 'SNA', 82.8, 4],
      ['SNB', 'SNB', 80.1, 3.9],
      ['ANB', 'ANB', 2.7, 2],
      ['SND', 'SND', 77.3, 3.8],
      ['Pog-NB(mm)', 'Pog-NB(mm)', 1, 1.5],
      ['OP-SN', 'OP-SN', 16.1, 5],
      ['GoGn-SN', 'GoGn-SN', 32.5, 5.2],
      ['SE(mm)', 'SE(mm)', 20.2, 2.6],
      ['SL(mm)', 'SL(mm)', 52.2, 5.4],
      ['U1-NA(mm)', 'U1-NA(mm)', 5.1, 2.4],
      ['U1-NA', 'U1-NA', 22.8, 5.7],
      ['L1-NB(mm)', 'L1-NB(mm)', 6.7, 2.1],
      ['L1-NB', 'L1-NB', 30.3, 5.8],
      ['U1-L1', 'U1-L1', 124, 8.2],
    ],
  },
  {
    code: 'pku',
    label: '北大分析法',
    items: [
      ['SNA', 'SNA', 82.8, 4],
      ['SNB', 'SNB', 80.1, 3.9],
      ['ANB', 'ANB', 2.7, 2],
      ['FH-NPo', 'FH-NPo', 85.4, 3.7],
      ['NA-APo', 'NA-APo', 6, 4.4],
      ['FH-MP', 'FH-MP', 31.1, 5.6],
      ['SGn-FH', 'SGn-FH', 66.3, 7.1],
      ['MP-SN', 'MP-SN', 32.5, 5.2],
      ['Pog-NB(mm)', 'Pog-NB(mm)', 1, 1.5],
      ['U1-NA(mm)', 'U1-NA(mm)', 5.1, 2.4],
      ['U1-NA', 'U1-NA', 22.8, 5.7],
      ['L1-NB(mm)', 'L1-NB(mm)', 6.7, 2.1],
      ['U1-L1', 'U1-L1', 125.4, 7.9],
      ['U1-SN', 'U1-SN', 105.7, 6.3],
      ['L1-MP', 'L1-MP', 91.6, 7],
    ],
  },
  {
    code: 'abo',
    label: 'ABO',
    items: [
      ['SNA', 'SNA', 82.8, 4],
      ['SNB', 'SNB', 80.1, 3.9],
      ['ANB', 'ANB', 2.7, 2],
      ['MP-SN', 'MP-SN', 35, 4],
      ['FH-MP', 'FH-MP', 27.3, 6.1],
      ['U1-NA(mm)', 'U1-NA(mm)', 5.1, 2.4],
      ['L1-NB(mm)', 'L1-NB(mm)', 6.7, 2.1],
      ['U1-SN', 'U1-SN', 105.7, 6.3],
      ['L1-MP', 'L1-MP', 91.6, 7],
      ['UL-EP(mm)', 'UL-EP(mm)', 2, 2],
      ['LL-EP(mm)', 'LL-EP(mm)', 3, 3],
    ],
  },
  {
    code: 'ricketts',
    label: 'Ricketts',
    items: [
      ['NBa-PtGn', 'NBa-PtGn', 93.2, 3.4],
      ['FH-NPo', 'FH-NPo', 88.2, 3.2],
      ['FH-MP', 'FH-MP', 27.6, 5.7],
      ['MP-SN', 'MP-SN', 32.5, 5.2],
      ['MP-NPo', 'MP-NPo', 66.3, 5],
      ['ANS-Xi-Pm', 'ANS-Xi-Pm', 47, 4],
      ['Dc-Xi-Pm', 'Dc-Xi-Pm', 26, 4],
      ['A-NPo(mm)', 'A-NPo(mm)', 3.7, 2.6],
      ['U1-APo(mm)', 'U1-APo(mm)', 7.6, 2],
      ['L1-APo(mm)', 'L1-APo(mm)', 4.6, 1.9],
      ['L1-APo', 'L1-APo', 24.4, 4.1],
      ['U6-PtV(mm)', 'U6-PtV(mm)', 17.8, 4.2],
      ['LL-EP(mm)', 'LL-EP(mm)', 0.3, 2.1],
    ],
  },
  {
    code: 'tweed',
    label: 'Tweed',
    items: [
      ['L1-FH', 'L1-FH', 54.9, 6.1],
      ['FH-MP', 'FH-MP', 31.3, 5],
      ['L1-MP', 'L1-MP', 93.9, 6.2],
      ['SNA', 'SNA', 82.8, 4],
      ['SNB', 'SNB', 80.1, 3.9],
      ['ANB', 'ANB', 2.7, 2],
      ['AO-BO(mm)', 'AO-BO(mm)', -1, 2.8],
      ['OP-FH', 'OP-FH', 10, 2],
      ['Z-Angle', 'Z-Angle', 75, 5],
      ['Upper thickness', 'Upper thickness', 14.1, 1.2],
      ["Pog'-NB(mm)", "Pog'-NB(mm)", 11.8, 1.2],
      ["Ar-Go'(mm)", "Ar-Go'(mm)", 44, 5],
      ['Me-PP(mm)', 'Me-PP(mm)', 63, 4],
      ["Ar-Go'/Me-PP(%)", "Ar-Go'/Me-PP(%)", 70, 5],
    ],
  },
  {
    code: 'mcnamara',
    label: 'McNamara',
    items: [
      ['A-Np(mm)', 'A-Np(mm)', 0.8, 2.1],
      ['Pog-Np(mm)', 'Pog-Np(mm)', -3.1, 4.9],
      ['Co-A(mm)', 'Co-A(mm)', 76, 3.9],
      ['Co-Gn(mm)', 'Co-Gn(mm)', 103.4, 5.3],
      ['ANS-Me(mm)', 'ANS-Me(mm)', 61, 3.4],
      ['U1-A(mm)', 'U1-A(mm)', 7, 2.4],
      ['L1-APog(mm)', 'L1-APog(mm)', 5.3, 2.7],
      ['FH-MP', 'FH-MP', 27.3, 6.1],
      ['NBa-PtGn', 'NBa-PtGn', 87, 4],
    ],
  },
  {
    code: 'jarabak',
    label: 'Jarabak',
    items: [
      ['N-S-Ar', 'N-S-Ar', 120.9, 5],
      ["S-Ar-Go'", "S-Ar-Go'", 148.5, 6.1],
      ["Ar-Go'-Me", "Ar-Go'-Me", 122.9, 5.6],
      ["Ar-Go'-N", "Ar-Go'-N", 53.5, 1.5],
      ["N-Go'-Me", "N-Go'-Me", 70, 2],
      ['Sum(S+Ar+Go)', 'Sum(S+Ar+Go)', 392.3, 6.4],
      ['S-N(mm)', 'S-N(mm)', 66, 3.4],
      ['Ar-S(mm)', 'Ar-S(mm)', 37.2, 5.2],
      ["Ar-Go'(mm)", "Ar-Go'(mm)", 46.3, 5.2],
      ["Go'-Me(mm)", "Go'-Me(mm)", 73.4, 4.9],
      ['N-Me(mm)', 'N-Me(mm)', 120.7, 7.3],
      ["S-Go'(mm)", "S-Go'(mm)", 79.9, 8.9],
      ['N-Go', 'N-Go', 122.6, 6.8],
      ['S-Me', 'S-Me', 130.3, 7.7],
      ["S-Ar/Ar-Go'(%)", "S-Ar/Ar-Go'(%)", 79.9, 6.3],
      ["Go'-Me/S-N'(%)", "Go'-Me/S-N'(%)", 111.2, 6.3],
      ["S-Go'/N-Me(%)", "S-Go'/N-Me(%)", 70.9, 4.2],
      ['SNA', 'SNA', 82.8, 4],
      ['SNB', 'SNB', 80.1, 3.9],
      ['ANB', 'ANB', 2.7, 2],
      ['GoGn-SN', 'GoGn-SN', 30.6, 5.2],
      ['SN-SGn', 'SN-SGn', 68.1, 4.1],
      ['SN-NPo', 'SN-NPo', 81.3, 4.2],
      ['NA-APo', 'NA-APo', 10.3, 3.2],
    ],
  },
];
const FEATURED_KEYPOINT_LABELS = new Set([
  'S', 'Na', 'Po', 'Ba', 'Bo', 'Or', 'Ptm', 'ANS', 'PNS', 'A', 'Sd', 'Pt', 'Co', 'Ar', 'Go', 'B', 'Id', 'Pog', 'Me', 'Gn',
  'D', 'DU', 'Pcd', 'Rp', 'Tpl', 'L1A', 'L1', 'L6', 'U6', 'U1A', 'U1', 'L6D', 'L6M', 'L6A', 'U6A', 'U6D', 'U6M',
  'G', "N'", 'Sn', 'UL', 'LL', 'Ls', 'Li', "Pog'", "Me'", 'Stmi', 'Stms', "B'", "Gn'", 'Cm', 'Prn', "A'", 'C',
  'B_A', 'Dmark', 'H1', 'Xi', 'Pt3', 'AD_O', 'airway7', 'airway5', 'airway45', 'airway4', 'airway3', 'airway2', 'airway1',
  'D_A', 'U', 'UD', 'R1', 'J', 'VC', 'V_A', 'V_O', 'AB1', 'AB', 'A_A', 'FA', 'Smp', 'PM', 'An', 'MPW', 'UPW', 'TPPW',
  'LPW', 'TB', 'AD2',
]);
const WEBPAGE_CURVE_ALPHA = 0.15;
const WEBPAGE_LINE_TEMPLATES = [
  {
    name: 'line_UpFace',
    stroke: '#22c55e',
    width: 2.4,
    pointsName: ['Fu0', 'G', 'Fu1', 'Fu2', "N'", 'Noseau0', 'Noseau1', 'Noseau2', 'Noseau3', 'Noseau9', 'Noseau5', 'Prn', 'Cm', 'Noseau6', 'Sn', 'Noseau10', "A'", 'UL', 'Ls', 'ULau1', 'Stms'],
  },
  {
    name: 'line_DownFace',
    stroke: '#22c55e',
    width: 2.4,
    pointsName: ['Stmi', 'LLau1', 'Li', 'LL', 'Soft_LP2', "B'", 'Soft_LP3', "Pog'", "Gn'", "Me'", 'F5', 'Smp', 'C'],
  },
  {
    name: 'line_Cheeks',
    stroke: '#f59e0b',
    width: 1.9,
    pointsName: ['Me', 'Man1', 'Man2', 'An', 'Tpl', 'Go', 'Rp', 'Man3', 'Ar', 'Pcd', 'Co', 'Go13', 'Go12', 'R3', 'Lj5', 'Lj4', 'Lj3', 'J'],
  },
  {
    name: 'line_UpTeeth2',
    stroke: '#f59e0b',
    width: 1.8,
    pointsName: ['Spr2', 'A3', 'A2', 'A1', 'PNS', 'A12', 'A11', 'A10', 'A9', 'A8', 'A7', 'ANS', 'A6', 'A', 'A5', 'Sd'],
  },
  {
    name: 'line_DownTeeth',
    stroke: '#fb923c',
    width: 1.8,
    pointsName: ['Id', 'B', 'PM', 'Pog', 'Gn', 'Me', 'Bone_LP4', 'Bone_LP3', 'Bone_LP2', 'Bone_LP1', 'Id2'],
  },
  {
    name: 'line_Eyes',
    stroke: '#38bdf8',
    width: 1.8,
    pointsName: ['Or1', 'Or', 'Or2', 'Orau1', 'Or4', 'Or0'],
  },
  {
    name: 'line_Ruler',
    stroke: '#34d399',
    width: 2,
    opacity: 0.95,
    dasharray: '5 4',
    pointsName: ['Ruler0', 'Ruler1'],
  },
  {
    name: 'line_Head2',
    stroke: '#60a5fa',
    width: 1.8,
    pointsName: ['Ns1', 'Noseau7', 'Na'],
  },
  {
    name: 'line_Head',
    stroke: '#60a5fa',
    width: 1.8,
    pointsName: ['G1', 'N2', 'Na', 'N6', 'Noseau4', 'Noseau8', 'Ns1'],
  },
  {
    name: 'line_Head4',
    stroke: '#60a5fa',
    width: 1.7,
    pointsName: ['S9', 'W_O', 'S10', 'S11'],
  },
  {
    name: 'line_Head5',
    stroke: '#60a5fa',
    width: 1.7,
    pointsName: ['Ptm', 'Pt3', 'Pt', 'Pt1', 'Pt2', 'Pt4', 'Ptm1'],
  },
  {
    name: 'line_Head6',
    stroke: '#60a5fa',
    width: 1.7,
    pointsName: ['Ba', 'Ba3', 'Ba4', 'Ba5', 'Ba7', 'Ba6', 'W_O', 'Ba8'],
  },
  {
    name: 'line_Head3',
    stroke: '#60a5fa',
    width: 2.1,
    pointsName: ['S0Ba0', 'S0Ba1', 'Sella1', 'S14', 'Sella2', 'S12', 'S9', 'Sella3', 'Sella4', 'Sella5', 'Sella6', 'Sella7', 'S3', 'S2', 'Ba1', 'Ba2', 'Ba'],
  },
  {
    name: 'spine_C2',
    stroke: 'hsl(270 90% 72%)',
    width: 1.9,
    closePath: true,
    pointsName: ['C2p', 'C2_2', 'C2d', 'C2_4', 'C2a', 'C2_6', 'C2_7', 'C2_8', 'C2_9', 'C2_10', 'C2_11', 'C2_12', 'C2_13', 'C2_14', 'C2_15', 'C2_16', 'C2_17', 'C2_18', 'C2_19', 'C2_20'],
  },
  {
    name: 'spine_C3',
    stroke: 'hsl(282 90% 72%)',
    width: 1.9,
    closePath: true,
    pointsName: ['C3up', 'C3_2', 'C3_3', 'C3_4', 'C3lp', 'C3_6', 'C3d', 'C3_8', 'C3la', 'C3_10', 'C3am', 'C3_12', 'C3ua', 'C3_14', 'C3um', 'C3_16'],
  },
  {
    name: 'spine_C4',
    stroke: 'hsl(294 90% 72%)',
    width: 1.9,
    closePath: true,
    pointsName: ['C4up', 'C4_2', 'C4_3', 'C4_4', 'C4lp', 'C4_6', 'C4d', 'C4_8', 'C4la', 'C4_10', 'C4am', 'C4_12', 'C4ua', 'C4_14', 'C4um', 'C4_16'],
  },
  {
    name: 'spine_C5',
    stroke: 'hsl(306 90% 72%)',
    width: 1.9,
    closePath: true,
    pointsName: ['C5up', 'C5_2', 'C5_3', 'C5_4', 'C5lp', 'C5_6', 'C5d', 'C5_8', 'C5la', 'C5_10', 'C5am', 'C5_12', 'C5ua', 'C5_14', 'C5um', 'C5_16'],
  },
  {
    name: 'spine_C6',
    stroke: 'hsl(318 90% 72%)',
    width: 1.9,
    closePath: true,
    pointsName: ['C6up', 'C6_2', 'C6_3', 'C6_4', 'C6lp', 'C6_6', 'C6d', 'C6_8', 'C6la', 'C6_10', 'C6am', 'C6_12', 'C6ua', 'C6_14', 'C6um', 'C6_16'],
  },
  {
    name: 'airway_1',
    stroke: '#a78bfa',
    width: 1.8,
    pointsName: ['airway1', 'airway2', 'airway3', 'airway4', 'airway45', 'airway5', 'AD_O', 'airway7'],
  },
  {
    name: 'airway_2',
    stroke: '#c084fc',
    width: 1.8,
    closePath: true,
    pointsName: ['U', 'DU', 'D_A', 'UD'],
  },
  {
    name: 'airway_3',
    stroke: '#c084fc',
    width: 1.8,
    pointsName: ['A_A', 'AB', 'AB1', 'B_A', 'V_O', 'V_A', 'VC'],
  },
  {
    name: 'airway_pns_upw',
    stroke: '#c084fc',
    width: 1.6,
    opacity: 0.84,
    pointsName: ['PNS', 'UPW'],
  },
  {
    name: 'airway_pns_ad2',
    stroke: '#c084fc',
    width: 1.6,
    opacity: 0.84,
    pointsName: ['PNS', 'AD2'],
  },
  {
    name: 'airway_U_MPW',
    stroke: '#c084fc',
    width: 1.6,
    opacity: 0.84,
    pointsName: ['U', 'MPW'],
  },
  {
    name: 'airway_tb_TPPW',
    stroke: '#c084fc',
    width: 1.6,
    opacity: 0.84,
    pointsName: ['TB', 'TPPW'],
  },
  {
    name: 'airway_V_LPW',
    stroke: '#c084fc',
    width: 1.6,
    opacity: 0.84,
    pointsName: ['V_O', 'LPW'],
  },
  {
    name: 'airway_BA_S',
    stroke: '#c084fc',
    width: 1.6,
    opacity: 0.84,
    pointsName: ['Ba', 'S'],
  },
  {
    name: 'airway_UPW_Ba',
    stroke: '#c084fc',
    width: 1.6,
    opacity: 0.84,
    pointsName: ['UPW', 'Ba'],
  },
  {
    name: 'airway_B_TB',
    stroke: '#c084fc',
    width: 1.6,
    opacity: 0.84,
    pointsName: ['B', 'TB'],
  },
];
const TOOTH_FILL_TEMPLATES = [
  {
    name: 'fill_line_up_tooth_1',
    anchorNames: ['U1A', 'U1'],
    order: TOOTH_TEMPLATE_DATA.upperIncisorOrder,
    templatePoints: TOOTH_TEMPLATE_DATA.upperIncisorTemplate,
    fill: '#fcd34d',
    fillOpacity: 0.28,
    stroke: '#f59e0b',
    strokeOpacity: 0.9,
    strokeWidth: 1.15,
  },
  {
    name: 'fill_line_low_tooth_1',
    anchorNames: ['L1A', 'L1'],
    order: TOOTH_TEMPLATE_DATA.lowerIncisorOrder,
    templatePoints: TOOTH_TEMPLATE_DATA.lowerIncisorTemplate,
    fill: '#fcd34d',
    fillOpacity: 0.28,
    stroke: '#f59e0b',
    strokeOpacity: 0.9,
    strokeWidth: 1.15,
  },
  {
    name: 'fill_line_top_teeth_1',
    anchorNames: ['U6D', 'U6M'],
    order: TOOTH_TEMPLATE_DATA.upperMolarOrder,
    templatePoints: TOOTH_TEMPLATE_DATA.upperMolarTemplate,
    fill: '#fde68a',
    fillOpacity: 0.24,
    stroke: '#f59e0b',
    strokeOpacity: 0.84,
    strokeWidth: 1.05,
  },
  {
    name: 'fill_line_low_teeth_1',
    anchorNames: ['L6D', 'L6M'],
    order: TOOTH_TEMPLATE_DATA.lowerMolarOrder,
    templatePoints: TOOTH_TEMPLATE_DATA.lowerMolarTemplate,
    fill: '#fde68a',
    fillOpacity: 0.24,
    stroke: '#f59e0b',
    strokeOpacity: 0.84,
    strokeWidth: 1.05,
  },
].map((template) => ({
  ...template,
  templateLookup: new Map(template.templatePoints.map((point) => [point.landmark, point])),
}));

function printHelp() {
  console.log(`Usage:
  node scripts/latera-ceph-cli.mjs --image /abs/path/to/lateral.png [options]
  node scripts/latera-ceph-cli.mjs --share-url 'https://pd.aiyayi.com/latera/?a=...' [options]
  node scripts/latera-ceph-cli.mjs --current-case [options]

Auth:
  --token <xiaoliutoken>         Reuse an existing xiaoliutoken
  --share-url <url>              Decode Latera share URL and reuse its token/ptId/version
  --username <name>              Doctor username for automatic login
  --password <password>          Doctor password for automatic login
  --mgr                          Use auth/login instead of doctor/doc/login

Options:
  --output <file>                Output JSON path
  --annotated-output <file>      Output SVG overlay path
  --annotated-png-output <file>  Output PNG overlay path
  --api-key <key>                HYFCeph API Key
  --portal-base-url <url>        HYFCeph portal URL, default: ${DEFAULT_PORTAL_BASE_URL}
  --skip-portal-validation       Skip portal API-key validation and portal event callbacks
  --downloaded-image-output <file> Save the image fetched from --share-url here
  --session-file <file>          Cache validated xiaoliutoken here
  --bridge-file <file>           Legacy local bridge fallback state file
  --page-url <url>               Latera page URL, default: ${DEFAULT_PAGE_URL}
  --api-base <url>               Override REST API base
  --client-id <id>               Override client id
  --x-app-key <key>              Override X-APP-KEY
  --algorithm-name <name>        Default: ${DEFAULT_ALGORITHM_NAME}
  --poll-ms <ms>                 Poll interval, default: 1000
  --timeout-seconds <sec>        Poll timeout, default: 180
  --force-refresh-algorithm-token  Force refresh algorithm token
  --current-case                 Use the latest browser-synced case from HYFCeph cloud bridge
  --no-session-cache             Do not read or write the local token cache
  --no-annotated-svg             Skip annotated SVG generation
  --dry-run                      Resolve config and auth only, skip upload/task

Env fallbacks:
  HYFCEPH_API_KEY
  HYFCEPH_PORTAL_BASE_URL
  LATERA_TOKEN / XIAOLIU_TOKEN
  LATERA_USERNAME / LATERA_PASSWORD
`);
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function defaultOutputPath(imagePath) {
  const parsed = path.parse(imagePath);
  return path.join(parsed.dir, `${parsed.name}.ceph_keypoints.json`);
}

function defaultAnnotatedSvgPath(imagePath) {
  const parsed = path.parse(imagePath);
  return path.join(parsed.dir, `${parsed.name}.ceph_keypoints.annotated.svg`);
}

function defaultAnnotatedPngPath(imagePath) {
  const parsed = path.parse(imagePath);
  return path.join(parsed.dir, `${parsed.name}.ceph_keypoints.annotated.png`);
}

function defaultSessionFile() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'state', 'latera-ceph-remote-session.json');
}

function defaultBridgeFile() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'state', 'latera-ceph-remote-current-case.json');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high);
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function md5Hex(value) {
  return createHash('md5').update(value).digest('hex');
}

function formatBearer(token) {
  if (!token) return '';
  return token.startsWith('Bearer ') ? token : `Bearer ${token}`;
}

function inferMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.bmp':
      return 'image/bmp';
    case '.tif':
    case '.tiff':
      return 'image/tiff';
    default:
      return 'application/octet-stream';
  }
}

function extensionFromMimeType(mimeType) {
  switch (String(mimeType || '').split(';')[0].trim().toLowerCase()) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/bmp':
      return '.bmp';
    case 'image/tiff':
      return '.tif';
    default:
      return '';
  }
}

function extensionFromUrl(value) {
  try {
    const ext = path.extname(new URL(value).pathname).toLowerCase();
    return ext || '';
  } catch {
    return '';
  }
}

function runOpenSslShareDecrypt(normalizedValue) {
  const commandSets = [
    ['enc', '-provider', 'default', '-provider', 'legacy', '-des-ecb', '-d', '-a', '-A', '-nosalt', '-K', SHARE_DES_KEY_BYTES.toString('hex')],
    ['enc', '-des-ecb', '-d', '-a', '-A', '-nosalt', '-K', SHARE_DES_KEY_BYTES.toString('hex')],
  ];
  let lastError = null;
  for (const args of commandSets) {
    try {
      return execFileSync('openssl', args, {
        encoding: 'utf8',
        input: normalizedValue,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('OpenSSL decryption failed');
}

function decryptLateraShareParam(value) {
  const normalizedValue = String(value || '').trim().replace(/ /g, '+');
  if (!normalizedValue) {
    throw new Error('Latera share URL is missing a valid a= parameter');
  }

  try {
    if (getCiphers().includes('des-ecb')) {
      const decipher = createDecipheriv('des-ecb', SHARE_DES_KEY_BYTES, null);
      decipher.setAutoPadding(true);
      return Buffer.concat([
        decipher.update(normalizedValue, 'base64'),
        decipher.final(),
      ]).toString('utf8').trim();
    }
  } catch {
    // Fall through to the OpenSSL CLI fallback.
  }

  try {
    return runOpenSslShareDecrypt(normalizedValue);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to decrypt Latera share URL. Install openssl or provide --token directly. ${reason}`);
  }
}

function parseLateraShareUrl(value) {
  const shareUrl = new URL(value);
  const encryptedPayload = shareUrl.searchParams.get('a');
  if (!encryptedPayload) {
    throw new Error('Latera share URL is missing the a= parameter');
  }

  const decryptedText = decryptLateraShareParam(encryptedPayload);
  let payload;
  try {
    payload = JSON.parse(decryptedText);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Latera share payload is not valid JSON: ${reason}`);
  }

  return {
    shareUrl: shareUrl.toString(),
    pageUrl: ensureTrailingSlash(new URL('./', shareUrl).toString()),
    payload,
    token: typeof payload?.token === 'string' ? payload.token.trim() : '',
    ptId: coerceNumber(payload?.ptId),
    ptVersion: coerceNumber(payload?.ptVersion ?? payload?.version),
    accountType: typeof payload?.accountType === 'string' ? payload.accountType : null,
    lang: typeof payload?.lang === 'string' ? payload.lang : null,
  };
}

function defaultDownloadedImagePath({ ptId, ptVersion, imageUrl }) {
  const ext = extensionFromUrl(imageUrl) || '.jpg';
  return path.resolve(`latera-pt${ptId}-v${ptVersion}${ext}`);
}

async function readSessionCache(sessionFile) {
  try {
    const raw = await fs.readFile(sessionFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.token !== 'string' || !parsed.token.trim()) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeSessionCache(sessionFile, session) {
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, JSON.stringify(session, null, 2));
}

async function readBridgeState(bridgeFile) {
  try {
    const raw = await fs.readFile(bridgeFile, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function buildBridgeContext(bridgeState) {
  if (!bridgeState || typeof bridgeState !== 'object') return null;

  let parsedShareContext = null;
  const shareUrl = typeof bridgeState.shareUrl === 'string' ? bridgeState.shareUrl.trim() : '';
  if (shareUrl) {
    try {
      parsedShareContext = parseLateraShareUrl(shareUrl);
    } catch {
      parsedShareContext = null;
    }
  }

  const ptId = parsedShareContext?.ptId ?? coerceNumber(bridgeState.ptId);
  const ptVersion = parsedShareContext?.ptVersion
    ?? coerceNumber(bridgeState.ptVersion ?? bridgeState.version);
  const token = parsedShareContext?.token
    || ((typeof bridgeState.token === 'string' && bridgeState.token.trim())
      ? bridgeState.token.trim()
      : '');

  return {
    source: typeof bridgeState.source === 'string' && bridgeState.source
      ? bridgeState.source
      : 'browser-bridge',
    pageUrl: typeof bridgeState.pageUrl === 'string' && bridgeState.pageUrl
      ? bridgeState.pageUrl
      : parsedShareContext?.pageUrl || null,
    shareUrl,
    href: typeof bridgeState.href === 'string' ? bridgeState.href : null,
    title: typeof bridgeState.title === 'string' ? bridgeState.title : null,
    token,
    ptId,
    ptVersion,
    accountType: parsedShareContext?.accountType
      || (typeof bridgeState.accountType === 'string' ? bridgeState.accountType : null),
    lang: parsedShareContext?.lang
      || (typeof bridgeState.lang === 'string' ? bridgeState.lang : null),
    syncedAt: typeof bridgeState.syncedAt === 'string' ? bridgeState.syncedAt : null,
    shareContext: parsedShareContext,
  };
}

function isRecentBridgeContext(bridgeContext, maxAgeMinutes = 45) {
  if (!bridgeContext?.syncedAt) {
    return false;
  }
  const syncedAt = new Date(bridgeContext.syncedAt).getTime();
  if (!Number.isFinite(syncedAt)) {
    return false;
  }
  return Date.now() - syncedAt <= maxAgeMinutes * 60 * 1000;
}

async function readJsonResponse(response) {
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Expected JSON but got: ${text.slice(0, 300)}`);
  }
  return data;
}

async function requestJson(url, {
  method = 'GET',
  headers = {},
  query,
  body,
  expectStatus = 200,
} = {}) {
  const requestUrl = new URL(url);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      requestUrl.searchParams.set(key, String(value));
    }
  }

  const finalHeaders = { ...headers };
  let payload = body;
  if (body && !(body instanceof FormData) && !(body instanceof Blob) && typeof body !== 'string') {
    payload = JSON.stringify(body);
    finalHeaders['Content-Type'] ??= 'application/json';
  }

  const response = await fetch(requestUrl, {
    method,
    headers: finalHeaders,
    body: method === 'GET' || method === 'HEAD' ? undefined : payload,
  });

  if (expectStatus && response.status !== expectStatus) {
    const fallbackText = await response.text();
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${fallbackText.slice(0, 500)}`);
  }

  return readJsonResponse(response);
}

async function requestRaw(url, {
  method = 'GET',
  headers = {},
  body,
} = {}) {
  const response = await fetch(url, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  }
  return response;
}

async function validatePortalApiKey({ portalBaseUrl, apiKey }) {
  const result = await requestJson(new URL('api/validate-key', portalBaseUrl).toString(), {
    method: 'POST',
    body: { apiKey },
  });
  if (!result?.valid) {
    throw new Error(result?.error || 'HYFCeph API Key 校验失败');
  }
  return result;
}

async function fetchPortalBridgeCurrentCase({ portalBaseUrl, apiKey }) {
  const response = await fetch(new URL('api/bridge/current-case', portalBaseUrl), {
    method: 'GET',
    headers: {
      'x-api-key': apiKey,
    },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HYFCeph cloud bridge lookup failed: HTTP ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  }

  return readJsonResponse(response);
}

async function notifyPortalSkillEvent({
  portalBaseUrl,
  apiKey,
  eventType,
  imageName,
  imageSource,
}) {
  try {
    await requestJson(new URL('api/skill-events', portalBaseUrl).toString(), {
      method: 'POST',
      body: {
        apiKey,
        eventType,
        imageName,
        imageSource,
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`Skill event notification failed: ${reason}`);
  }
}

function unwrapApiResult(result, label) {
  if (result?.code === 200 || result?.code === 0) {
    return result;
  }
  if (result?.status === 'SUCCESS' || result?.status === 'PENDING') {
    return result;
  }
  const message = result?.msg || result?.message || JSON.stringify(result);
  throw new Error(`${label} failed: ${message}`);
}

function extractTokenFromLogin(result) {
  const candidates = [
    result?.data?.access_token,
    result?.data?.token,
    result?.data?.accessToken,
    result?.access_token,
    result?.token,
    result?.accessToken,
  ];
  const token = candidates.find(Boolean);
  if (!token) {
    throw new Error(`Could not find login token in response: ${JSON.stringify(result).slice(0, 500)}`);
  }
  return token;
}

function buildApiBase(pageUrl, overrideBase) {
  if (overrideBase) return ensureTrailingSlash(new URL(overrideBase).toString());
  return ensureTrailingSlash(new URL('api/', pageUrl).toString());
}

function buildCallbackUrl(pageUrl) {
  return new URL('/api/design/algorithm/receiveResult', pageUrl).toString();
}

async function fetchAppSettings(pageUrl) {
  const settingsUrl = new URL('custom/appSetting.js?v=0.0.1', pageUrl).toString();
  try {
    const response = await requestRaw(settingsUrl);
    const script = await response.text();
    const clientId = script.match(/window\.clientId\s*=\s*'([^']+)'/)?.[1] || DEFAULT_CLIENT_ID;
    const xAppKey = script.match(/window\.xAppKey\s*=\s*'([^']+)'/)?.[1] || DEFAULT_X_APP_KEY;
    return { clientId, xAppKey, source: settingsUrl };
  } catch {
    return {
      clientId: DEFAULT_CLIENT_ID,
      xAppKey: DEFAULT_X_APP_KEY,
      source: 'fallback-constants',
    };
  }
}

function buildAppHeaders({ clientId, xAppKey, token }) {
  const headers = {
    'X-APP-KEY': xAppKey,
    Clientid: clientId,
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
  if (token) {
    headers.xiaoliutoken = formatBearer(token);
  }
  return headers;
}

async function loginDoctor({ apiBase, clientId, xAppKey, username, password, mgr }) {
  const loginPath = mgr ? 'auth/login' : 'doctor/doc/login';
  const payload = mgr ? {
    clientId,
    grantType: 'password',
    username,
    password,
  } : {
    clientId,
    grantType: 'password',
    userName: username,
    pwd: md5Hex(password),
  };

  const result = await requestJson(new URL(loginPath, apiBase).toString(), {
    method: 'POST',
    headers: buildAppHeaders({ clientId, xAppKey }),
    body: payload,
  });

  return extractTokenFromLogin(unwrapApiResult(result, 'login'));
}

async function getAlgorithmAccess({ apiBase, clientId, xAppKey, xiaoliutoken, force }) {
  const result = await requestJson(new URL('design/algorithm/getAccessToken', apiBase).toString(), {
    headers: buildAppHeaders({ clientId, xAppKey, token: xiaoliutoken }),
    query: { force: force ? 'true' : 'false' },
  });

  const payload = unwrapApiResult(result, 'getAccessToken').data || result.data || result;
  if (!payload?.accessToken || !payload?.baseUrl) {
    throw new Error(`Unexpected algorithm token response: ${JSON.stringify(result).slice(0, 500)}`);
  }

  const algorithmBase = GA_HOST_MAP.has(new URL(payload.baseUrl).host)
    ? 'https://aiapi-ga.waveatp.com'
    : payload.baseUrl;

  return {
    algorithmToken: payload.accessToken,
    algorithmBase: ensureTrailingSlash(algorithmBase),
  };
}

function buildAlgorithmHeaders(algorithmToken) {
  return {
    Authorization: algorithmToken,
    'Content-Security-Policy': 'upgrade-insecure-requests',
  };
}

async function fetchSharedLateralImageUrl({
  apiBase,
  clientId,
  xAppKey,
  xiaoliutoken,
  ptId,
  ptVersion,
}) {
  const result = await requestJson(new URL('doctor/pic/lateral', apiBase).toString(), {
    headers: buildAppHeaders({ clientId, xAppKey, token: xiaoliutoken }),
    query: {
      ptId,
      ptVersion,
    },
  });

  const payload = unwrapApiResult(result, 'lateral image').data ?? result.data ?? result;
  if (typeof payload !== 'string' || !/^https?:\/\//.test(payload)) {
    throw new Error(`Unexpected lateral image response: ${JSON.stringify(result).slice(0, 500)}`);
  }
  return payload;
}

async function downloadRemoteImage(url, outputPath) {
  const response = await requestRaw(url);
  const mimeType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || '';
  let resolvedPath = path.resolve(outputPath);
  if (!path.extname(resolvedPath)) {
    resolvedPath += extensionFromMimeType(mimeType) || '.jpg';
  }

  const arrayBuffer = await response.arrayBuffer();
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, Buffer.from(arrayBuffer));

  return {
    resolvedPath,
    mimeType: mimeType || inferMimeType(resolvedPath),
  };
}

async function fetchUploadSignature({ algorithmBase, algorithmToken, algorithmName }) {
  const result = await requestJson(new URL('file_signature/direct_upload/', algorithmBase).toString(), {
    headers: buildAlgorithmHeaders(algorithmToken),
    query: { name: algorithmName },
  });

  const payload = unwrapApiResult(result, 'direct upload signature').data || result.data;
  if (!payload?.token || !payload?.task_id) {
    throw new Error(`Unexpected upload signature response: ${JSON.stringify(result).slice(0, 500)}`);
  }

  return payload;
}

async function uploadImageToOss({ uploadSignature, fileBlob, fileName, algorithmToken }) {
  const uploadPath = `${uploadSignature.token.upload_dir}${fileName}`;
  const form = new FormData();
  form.append('key', uploadPath);
  form.append('policy', uploadSignature.token.policy);
  form.append('signature', uploadSignature.token.signature);
  form.append('OSSAccessKeyId', uploadSignature.token.accessid);
  form.append('file', fileBlob, fileName);

  await requestRaw(uploadSignature.token.host, {
    method: 'POST',
    headers: { Authorization: algorithmToken },
    body: form,
  });

  return {
    taskId: uploadSignature.task_id,
    uploadPath,
  };
}

async function createTask({ algorithmBase, algorithmToken, algorithmName, taskId, callbackUrl, imageFilePath }) {
  const result = await requestJson(new URL('tasks/', algorithmBase).toString(), {
    method: 'POST',
    headers: buildAlgorithmHeaders(algorithmToken),
    body: {
      name: algorithmName,
      task_id: taskId,
      callback_url: callbackUrl,
      args: {
        image_file: imageFilePath,
        formatResult: false,
      },
      priority: 0,
    },
  });

  return unwrapApiResult(result, 'task creation');
}

async function pollTaskResult({ algorithmBase, algorithmToken, taskId, pollMs, timeoutSeconds }) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const url = new URL(`tasks/${taskId}/result/`, algorithmBase).toString();

  while (Date.now() < deadline) {
    const result = await requestJson(url, {
      headers: buildAlgorithmHeaders(algorithmToken),
    });

    const status = result?.data?.status;
    if (status === 'SUCCESS') {
      return result.data.result;
    }
    if (status === 'FAILURE') {
      throw new Error(`Algorithm task failed: ${JSON.stringify(result).slice(0, 500)}`);
    }

    await sleep(pollMs);
  }

  throw new Error(`Timed out waiting for algorithm result after ${timeoutSeconds}s`);
}

async function resolveResultPayload(resultIndex) {
  const firstUrl = Object.values(resultIndex || {}).find(
    (value) => typeof value === 'string' && /^https?:\/\//.test(value),
  );
  if (!firstUrl) {
    return null;
  }

  const response = await requestRaw(firstUrl);
  return {
    url: firstUrl,
    payload: await readJsonResponse(response),
  };
}

function summarizePayload(payload) {
  if (!payload) return {};
  const data = payload?.data || payload || {};
  return {
    headPoints: Array.isArray(data.head) ? data.head.length : 0,
    rulerPoints: Array.isArray(data?.ruler?.kps) ? data.ruler.kps.length : 0,
    spineSections: Array.isArray(data.spine) ? data.spine.length : 0,
    hasRuler: Boolean(data.ruler),
  };
}

function coerceNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeLandmarkToken(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function canonicalLandmarkName(rawName) {
  const trimmed = String(rawName || '').trim();
  if (!trimmed) return null;
  return LANDMARK_ALIAS_MAP.get(trimmed.toLowerCase()) || trimmed;
}

function extractLateraPoint(item, source) {
  if (!item || typeof item !== 'object') return null;
  const rawLandmark = item.landmark || item.name || item.realLandmark;
  const position = Array.isArray(item.position) ? item.position : [];
  const x = coerceNumber(item.x ?? position[0]);
  const y = coerceNumber(item.y ?? position[1]);
  const landmark = rawLandmark ? String(rawLandmark).trim() : '';
  const key = canonicalLandmarkName(landmark);
  if (!landmark || !key || x === null || y === null) {
    return null;
  }

  const confidence = coerceNumber(item.confidence);
  return {
    landmark,
    key,
    source,
    x: round1(x),
    y: round1(y),
    confidence,
  };
}

function collectLateraLandmarks(payload) {
  const data = payload?.data || payload || {};
  const rawPoints = [];

  if (Array.isArray(data.head)) {
    rawPoints.push(...data.head.map((item) => [item, 'head']));
  }
  if (Array.isArray(data?.ruler?.kps)) {
    rawPoints.push(...data.ruler.kps.map((item) => [item, 'ruler']));
  }
  if (Array.isArray(data.spine)) {
    rawPoints.push(...data.spine.flatMap((section) => (Array.isArray(section?.kps) ? section.kps : []).map((item) => [item, 'spine'])));
  }

  return rawPoints
    .map(([item, source]) => extractLateraPoint(item, source))
    .filter(Boolean);
}

function collectOverlayData(payload) {
  const data = payload?.data || payload || {};
  const headPoints = Array.isArray(data.head)
    ? data.head.map((item) => extractLateraPoint(item, 'head')).filter(Boolean)
    : [];
  const rulerPoints = Array.isArray(data?.ruler?.kps)
    ? data.ruler.kps.map((item) => extractLateraPoint(item, 'ruler')).filter(Boolean)
    : [];
  const spineSections = Array.isArray(data.spine)
    ? data.spine
      .map((section, index) => ({
        name: String(section?.name || `spine-${index + 1}`),
        points: Array.isArray(section?.kps)
          ? section.kps.map((item) => extractLateraPoint(item, 'spine')).filter(Boolean)
          : [],
      }))
      .filter((section) => section.points.length)
    : [];

  return {
    headPoints,
    rulerPoints,
    spineSections,
  };
}

function buildPointLookup(points) {
  const lookup = new Map();
  for (const point of points) {
    if (!lookup.has(point.landmark)) {
      lookup.set(point.landmark, point);
    }
  }
  return lookup;
}

function buildTemplateSegments(template, pointLookup) {
  if (template.closePath) {
    const points = template.pointsName.map((landmark) => pointLookup.get(landmark));
    if (points.some((point) => !point) || points.length < 3) {
      return [];
    }
    return [points];
  }

  const segments = [];
  let current = [];

  for (const landmark of template.pointsName) {
    const point = pointLookup.get(landmark);
    if (point) {
      current.push(point);
      continue;
    }
    if (current.length >= 2) {
      segments.push(current);
    }
    current = [];
  }

  if (current.length >= 2) {
    segments.push(current);
  }

  return segments;
}

function buildSmoothPath(points, closePath = false) {
  if (points.length < 2) {
    return '';
  }
  const curveFactory = closePath
    ? curveCatmullRomClosed.alpha(WEBPAGE_CURVE_ALPHA)
    : curveCatmullRom.alpha(WEBPAGE_CURVE_ALPHA);
  const generator = svgLine()
    .x((point) => point.x)
    .y((point) => point.y)
    .curve(curveFactory);
  return generator(points) || '';
}

class SimilarityTransform {
  constructor(scaleReal, scaleImaginary, translateX, translateY) {
    this.scaleReal = scaleReal;
    this.scaleImaginary = scaleImaginary;
    this.translateX = translateX;
    this.translateY = translateY;
  }

  transformPoint(point) {
    return {
      landmark: point.landmark,
      x: round1(this.scaleReal * point.x - this.scaleImaginary * point.y + this.translateX),
      y: round1(this.scaleImaginary * point.x + this.scaleReal * point.y + this.translateY),
    };
  }
}

function buildSimilarityTransform(sourcePoints, targetPoints) {
  const count = Math.min(sourcePoints.length, targetPoints.length);
  if (count < 2) {
    return null;
  }

  let sourceXSum = 0;
  let sourceYSum = 0;
  let targetXSum = 0;
  let targetYSum = 0;
  let sourceSquaredSum = 0;
  let sourceYSquaredSum = 0;
  let sourceTargetXDot = 0;
  let sourceTargetYDot = 0;
  let sourceTargetXX = 0;
  let sourceTargetYY = 0;

  for (let index = 0; index < count; index += 1) {
    const sourcePoint = sourcePoints[index];
    const targetPoint = targetPoints[index];
    sourceXSum += sourcePoint.x;
    sourceYSum += sourcePoint.y;
    targetXSum += targetPoint.x;
    targetYSum += targetPoint.y;
    sourceSquaredSum += sourcePoint.x * sourcePoint.x;
    sourceYSquaredSum += sourcePoint.y * sourcePoint.y;
    sourceTargetXDot += sourcePoint.x * targetPoint.y;
    sourceTargetYDot += sourcePoint.y * targetPoint.x;
    sourceTargetXX += sourcePoint.x * targetPoint.x;
    sourceTargetYY += sourcePoint.y * targetPoint.y;
  }

  const denominator = count * sourceSquaredSum + count * sourceYSquaredSum - sourceXSum * sourceXSum - sourceYSum * sourceYSum;
  if (Math.abs(denominator) < 1e-8) {
    return null;
  }

  const scaleReal = (count * (sourceTargetXX + sourceTargetYY) - sourceXSum * targetXSum - sourceYSum * targetYSum) / denominator;
  const scaleImaginary = (count * (sourceTargetXDot - sourceTargetYDot) + sourceYSum * targetXSum - sourceXSum * targetYSum) / denominator;
  const translateX = (-sourceXSum * (sourceTargetXX + sourceTargetYY) + sourceYSum * (sourceTargetXDot - sourceTargetYDot) + sourceSquaredSum * targetXSum + sourceYSquaredSum * targetXSum) / denominator;
  const translateY = (-sourceYSum * (sourceTargetXX + sourceTargetYY) - sourceXSum * (sourceTargetXDot - sourceTargetYDot) + sourceSquaredSum * targetYSum + sourceYSquaredSum * targetYSum) / denominator;

  return new SimilarityTransform(scaleReal, scaleImaginary, translateX, translateY);
}

function buildToothFillShapes(pointLookup) {
  return TOOTH_FILL_TEMPLATES
    .map((template) => {
      const sourceAnchors = template.anchorNames.map((landmark) => template.templateLookup.get(landmark));
      const targetAnchors = template.anchorNames.map((landmark) => pointLookup.get(landmark));
      if (sourceAnchors.some((point) => !point) || targetAnchors.some((point) => !point)) {
        return null;
      }

      const transform = buildSimilarityTransform(sourceAnchors, targetAnchors);
      if (!transform) {
        return null;
      }

      const points = template.order
        .map((landmark) => template.templateLookup.get(landmark))
        .filter(Boolean)
        .map((point) => transform.transformPoint(point));

      return points.length >= 3
        ? {
          ...template,
          points,
        }
        : null;
    })
    .filter(Boolean);
}

function classifyHeadPoint(point) {
  if (PRIMARY_LANDMARK_KEYS.has(point.key)) {
    return 'primary';
  }
  if (FEATURED_KEYPOINT_LABELS.has(point.landmark)) {
    return 'keypoint';
  }
  return 'auxiliary';
}

function upsertPoint(pointMap, point) {
  const candidateKeys = [...new Set([point.key, point.landmark].filter(Boolean))];
  for (const candidateKey of candidateKeys) {
    const current = pointMap.get(candidateKey);
    if (!current || (current.source !== 'head' && point.source === 'head')) {
      pointMap.set(candidateKey, point);
    }
  }
}

function getPoint(pointMap, key) {
  const point = pointMap.get(key);
  if (!point) {
    throw new Error(`Missing ceph landmark: ${key}`);
  }
  return point;
}

function angleAt(pointA, pointB, pointC) {
  const vector1 = { x: pointA.x - pointB.x, y: pointA.y - pointB.y };
  const vector2 = { x: pointC.x - pointB.x, y: pointC.y - pointB.y };
  const length1 = Math.hypot(vector1.x, vector1.y);
  const length2 = Math.hypot(vector2.x, vector2.y);
  if (!length1 || !length2) {
    throw new Error('Zero-length vector while calculating ceph angle');
  }
  const dot = vector1.x * vector2.x + vector1.y * vector2.y;
  const cosine = clamp(dot / (length1 * length2), -1, 1);
  return (Math.acos(cosine) * 180) / Math.PI;
}

function angleBetweenLines(pointA, pointB, pointC, pointD) {
  const vector1 = { x: pointB.x - pointA.x, y: pointB.y - pointA.y };
  const vector2 = { x: pointD.x - pointC.x, y: pointD.y - pointC.y };
  const length1 = Math.hypot(vector1.x, vector1.y);
  const length2 = Math.hypot(vector2.x, vector2.y);
  if (!length1 || !length2) {
    throw new Error('Zero-length vector while calculating ceph line angle');
  }
  const dot = vector1.x * vector2.x + vector1.y * vector2.y;
  const cross = vector1.x * vector2.y - vector1.y * vector2.x;
  return (Math.atan2(cross, dot) * 180) / Math.PI;
}

function acuteAngleBetweenLines(pointA, pointB, pointC, pointD) {
  const raw = Math.abs(angleBetweenLines(pointA, pointB, pointC, pointD));
  return raw > 90 ? 180 - raw : raw;
}

function obtuseAngleBetweenLines(pointA, pointB, pointC, pointD) {
  return 180 - acuteAngleBetweenLines(pointA, pointB, pointC, pointD);
}

function distanceBetweenPoints(pointA, pointB) {
  return Math.hypot(pointB.x - pointA.x, pointB.y - pointA.y);
}

function midpoint(pointA, pointB) {
  return {
    x: (pointA.x + pointB.x) / 2,
    y: (pointA.y + pointB.y) / 2,
  };
}

function normalizeVector(vector) {
  const length = Math.hypot(vector.x, vector.y);
  if (!length) {
    throw new Error('Zero-length vector while normalizing');
  }
  return {
    x: vector.x / length,
    y: vector.y / length,
  };
}

function projectPointToLine(point, lineStart, lineEnd) {
  const vector = {
    x: lineEnd.x - lineStart.x,
    y: lineEnd.y - lineStart.y,
  };
  const lengthSquared = vector.x * vector.x + vector.y * vector.y;
  if (!lengthSquared) {
    throw new Error('Zero-length line while projecting point');
  }
  const projectionScale = (
    ((point.x - lineStart.x) * vector.x + (point.y - lineStart.y) * vector.y)
    / lengthSquared
  );
  return {
    x: lineStart.x + projectionScale * vector.x,
    y: lineStart.y + projectionScale * vector.y,
  };
}

function perpendicularDistanceToLine(point, lineStart, lineEnd) {
  const projected = projectPointToLine(point, lineStart, lineEnd);
  return distanceBetweenPoints(point, projected);
}

function signedDistanceAlongAxis(point, origin, unitVector) {
  return (point.x - origin.x) * unitVector.x + (point.y - origin.y) * unitVector.y;
}

function buildMeasurementScale(payload) {
  const data = payload?.data || payload || {};
  const rulerPoints = Array.isArray(data?.ruler?.kps)
    ? data.ruler.kps.map((item) => extractLateraPoint(item, 'ruler')).filter(Boolean)
    : [];
  const rulerDistanceMm = coerceNumber(data?.ruler?.ruler_distance);
  if (!rulerPoints.length || rulerPoints.length < 2 || !rulerDistanceMm) {
    return {
      hasRuler: false,
      rulerDistanceMm: null,
      rulerPixelLength: null,
      mmPerPx: null,
    };
  }
  const rulerPixelLength = distanceBetweenPoints(rulerPoints[0], rulerPoints[1]);
  if (!rulerPixelLength) {
    return {
      hasRuler: false,
      rulerDistanceMm,
      rulerPixelLength,
      mmPerPx: null,
    };
  }
  return {
    hasRuler: true,
    rulerDistanceMm: round1(rulerDistanceMm),
    rulerPixelLength: round1(rulerPixelLength),
    mmPerPx: rulerDistanceMm / rulerPixelLength,
  };
}

function formatItemValue(unit, value) {
  const rounded = round1(value);
  if (unit === 'mm') return `${rounded} mm`;
  if (unit === '%') return `${rounded}%`;
  return `${rounded}°`;
}

function buildFrameworkItem({
  code,
  label,
  unit = 'deg',
  value,
  reference = '',
  referenceMean = null,
  referenceSd = null,
  normalMin = null,
  normalMax = null,
  landmarks = [],
  formula = '',
}) {
  const rounded = round1(value);
  let tone = 'info';
  if (Number.isFinite(normalMin) && Number.isFinite(normalMax)) {
    if (rounded < normalMin || rounded > normalMax) {
      const overflow = rounded < normalMin ? normalMin - rounded : rounded - normalMax;
      tone = overflow >= 3 ? 'danger' : 'warn';
    } else {
      tone = 'success';
    }
  }
  return {
    code,
    label,
    unit,
    value: rounded,
    valueText: formatItemValue(unit, rounded),
    reference,
    referenceMean,
    referenceSd,
    tone,
    landmarks,
    formula,
    status: 'supported',
  };
}

function buildUnsupportedFrameworkItem({
  code,
  label,
  landmarks = [],
  formula = '',
  reference = '',
  referenceMean = null,
  referenceSd = null,
  reason,
}) {
  return {
    code,
    label,
    status: 'unsupported',
    reason,
    landmarks,
    formula,
    reference,
    referenceMean,
    referenceSd,
  };
}

function getOptionalPoint(pointMap, key) {
  return pointMap.get(key) || null;
}

function buildOcclusalPlane(pointMap) {
  const upperIncisor = getPoint(pointMap, 'U1T');
  const lowerIncisor = getPoint(pointMap, 'L1T');
  const upperMolar = getOptionalPoint(pointMap, 'U6') || midpoint(getPoint(pointMap, 'U6D'), getPoint(pointMap, 'U6M'));
  const lowerMolar = getOptionalPoint(pointMap, 'L6') || midpoint(getPoint(pointMap, 'L6D'), getPoint(pointMap, 'L6M'));
  return {
    anterior: midpoint(upperIncisor, lowerIncisor),
    posterior: midpoint(upperMolar, lowerMolar),
  };
}

function buildCommonGeometry(pointMap) {
  const safeLine = (start, end) => {
    try {
      return {
        start: getPoint(pointMap, start),
        end: getPoint(pointMap, end),
      };
    } catch {
      return null;
    }
  };
  const fhLine = safeLine('Po', 'Or');
  const snLine = safeLine('S', 'N');
  const mandibularPlane = safeLine('Go', 'Me');
  const facialPlane = safeLine('N', 'Pog');
  const apogLine = safeLine('A', 'Pog');
  let occlusalPlane = null;
  try {
    occlusalPlane = buildOcclusalPlane(pointMap);
  } catch {
    occlusalPlane = null;
  }
  return {
    fhLine,
    snLine,
    mandibularPlane,
    facialPlane,
    apogLine,
    occlusalPlane,
  };
}

function createDerivedPoint(name, x, y) {
  return {
    landmark: name,
    key: name,
    source: 'derived',
    x: round1(x),
    y: round1(y),
    confidence: null,
  };
}

function addDerivedPoint(pointMap, name, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  upsertPoint(pointMap, createDerivedPoint(name, x, y));
}

function buildRawPointLookupFromPointMap(pointMap) {
  const lookup = new Map();
  for (const point of pointMap.values()) {
    if (point?.landmark && !lookup.has(point.landmark)) {
      lookup.set(point.landmark, point);
    }
  }
  return lookup;
}

function lineIntersection(pointA, pointB, pointC, pointD) {
  const denominator = (pointA.x - pointB.x) * (pointC.y - pointD.y) - (pointA.y - pointB.y) * (pointC.x - pointD.x);
  if (Math.abs(denominator) < 1e-8) {
    return null;
  }
  return {
    x: ((pointA.x * pointB.y - pointA.y * pointB.x) * (pointC.x - pointD.x) - (pointA.x - pointB.x) * (pointC.x * pointD.y - pointC.y * pointD.x)) / denominator,
    y: ((pointA.x * pointB.y - pointA.y * pointB.x) * (pointC.y - pointD.y) - (pointA.y - pointB.y) * (pointC.x * pointD.y - pointC.y * pointD.x)) / denominator,
  };
}

function lineSegmentIntersection(pointA, pointB, pointC, pointD) {
  const intersection = lineIntersection(pointA, pointB, pointC, pointD);
  if (!intersection) return null;
  const epsilon = 1e-6;
  const within = (value, start, end) => value >= Math.min(start, end) - epsilon && value <= Math.max(start, end) + epsilon;
  if (
    within(intersection.x, pointA.x, pointB.x)
    && within(intersection.y, pointA.y, pointB.y)
    && within(intersection.x, pointC.x, pointD.x)
    && within(intersection.y, pointC.y, pointD.y)
  ) {
    return intersection;
  }
  return null;
}

function signedDistanceLikeWeb(lineStart, lineEnd, point) {
  const deltaX = lineEnd.x - lineStart.x;
  const deltaY = lineEnd.y - lineStart.y;
  if (Math.abs(deltaX) < 1e-8) {
    return point.x - lineStart.x;
  }
  const slope = deltaY / deltaX;
  const base = (slope * (point.x - lineStart.x) - (point.y - lineStart.y)) / Math.sqrt(slope ** 2 + 1);
  return slope > 0 ? base : -base;
}

function ensureWebDerivedPoints(pointMap) {
  try {
    const occlusalPlane = buildOcclusalPlane(pointMap);
    addDerivedPoint(pointMap, 'post_occlusal_point', occlusalPlane.posterior.x, occlusalPlane.posterior.y);
    addDerivedPoint(pointMap, 'ant_occlusal_point', occlusalPlane.anterior.x, occlusalPlane.anterior.y);
  } catch {
    // Ignore missing tooth anchors here; downstream items will surface unsupported status.
  }

  const rawLookup = buildRawPointLookupFromPointMap(pointMap);
  for (const shape of buildToothFillShapes(rawLookup)) {
    for (const point of shape.points) {
      if (!rawLookup.has(point.landmark) && !pointMap.has(point.landmark)) {
        addDerivedPoint(pointMap, point.landmark, point.x, point.y);
      }
    }
  }

  try {
    if (!pointMap.has("Go'")) {
      const goPrime = lineIntersection(
        getPoint(pointMap, 'Ar'),
        getPoint(pointMap, 'Rp'),
        getPoint(pointMap, 'Tpl'),
        getPoint(pointMap, 'Me'),
      );
      if (goPrime) {
        addDerivedPoint(pointMap, "Go'", goPrime.x, goPrime.y);
      }
    }
  } catch {
    // Ignore; the related items will be marked unsupported.
  }

  try {
    if (!pointMap.has('Xi')) {
      const fhStart = getPoint(pointMap, 'Po');
      const fhEnd = getPoint(pointMap, 'Or');
      const centerStart = getPoint(pointMap, 'J');
      const centerEnd = getPoint(pointMap, 'R3');
      const dx = fhEnd.x - fhStart.x;
      const dy = fhEnd.y - fhStart.y;
      const xi = lineIntersection(
        centerStart,
        { x: centerStart.x + dx, y: centerStart.y + dy },
        centerEnd,
        { x: centerEnd.x - dy, y: centerEnd.y + dx },
      );
      if (xi) {
        addDerivedPoint(pointMap, 'Xi', xi.x, xi.y);
      }
    }
  } catch {
    // Ignore; the related items will be marked unsupported.
  }

  try {
    if (!pointMap.has('DC')) {
      const nasion = getPoint(pointMap, 'N');
      const basion = getPoint(pointMap, 'Ba');
      const contour = RICKETTS_CONTOUR_KEYS.map((name) => pointMap.get(name)).filter(Boolean);
      const intersections = [];
      for (let index = 1; index < contour.length; index += 1) {
        const intersection = lineSegmentIntersection(nasion, basion, contour[index - 1], contour[index]);
        if (intersection) {
          intersections.push(intersection);
        }
      }
      if (intersections.length >= 2) {
        const first = intersections[0];
        const last = intersections[intersections.length - 1];
        addDerivedPoint(pointMap, 'DC', (first.x + last.x) / 2, (first.y + last.y) / 2);
      }
    }
  } catch {
    // Ignore; the related items will be marked unsupported.
  }
}

function inferFrameworkUnit(calculationId) {
  if (calculationId.includes('(%)')) return '%';
  if (calculationId.includes('(mm)') || calculationId === 'N-Go' || calculationId === 'S-Me') return 'mm';
  return 'deg';
}

function formatFrameworkReference(mean, sd, unit) {
  if (!Number.isFinite(mean) || !Number.isFinite(sd)) return '';
  const suffix = unit === '%' ? '%' : unit === 'mm' ? ' mm' : '°';
  return `参考: ${mean} ± ${sd}${suffix}`;
}

function lineAngle(pointMap, names) {
  const [a, b, c, d] = names.map((name) => getPoint(pointMap, name));
  return angleBetweenLines(a, b, c, d);
}

function triangleAngle(pointMap, names) {
  const [a, b, c] = names.map((name) => getPoint(pointMap, name));
  return angleAt(a, b, c);
}

function pointDistanceMm(pointMap, names, scale) {
  const [a, b] = names.map((name) => getPoint(pointMap, name));
  return distanceBetweenPoints(a, b) * scale.mmPerPx;
}

function pointLineDistanceMm(pointMap, lineNames, pointName, scale) {
  const lineStart = getPoint(pointMap, lineNames[0]);
  const lineEnd = getPoint(pointMap, lineNames[1]);
  const point = getPoint(pointMap, pointName);
  return perpendicularDistanceToLine(point, lineStart, lineEnd) * scale.mmPerPx;
}

function signedVrMm(pointMap, lineNames, pointName, scale) {
  const lineStart = getPoint(pointMap, lineNames[0]);
  const lineEnd = getPoint(pointMap, lineNames[1]);
  const point = getPoint(pointMap, pointName);
  return signedDistanceLikeWeb(lineStart, lineEnd, point) * scale.mmPerPx;
}

function projectionPoint(pointMap, lineNames, pointName) {
  const lineStart = getPoint(pointMap, lineNames[0]);
  const lineEnd = getPoint(pointMap, lineNames[1]);
  const point = getPoint(pointMap, pointName);
  return projectPointToLine(point, lineStart, lineEnd);
}

function projectedDistanceMm(pointMap, lineNames, firstPoint, secondPoint, scale) {
  const firstProjection = projectionPoint(pointMap, lineNames, firstPoint);
  const secondProjection = projectionPoint(pointMap, lineNames, secondPoint);
  return distanceBetweenPoints(firstProjection, secondProjection) * scale.mmPerPx;
}

function makeFrameworkSpec(unit, landmarks, formula, compute) {
  return { unit, landmarks, formula, compute };
}

function makeDegSpec(landmarks, formula, compute) {
  return makeFrameworkSpec('deg', landmarks, formula, compute);
}

function makeMmSpec(landmarks, formula, compute) {
  return makeFrameworkSpec('mm', landmarks, formula, compute);
}

function makePercentSpec(landmarks, formula, compute) {
  return makeFrameworkSpec('%', landmarks, formula, compute);
}

const FRAMEWORK_CALCULATION_REGISTRY = {
  'SNA': makeDegSpec(['S', 'N', 'A'], '∠SNA', ({ pointMap }) => triangleAngle(pointMap, ['S', 'N', 'A'])),
  'SNB': makeDegSpec(['S', 'N', 'B'], '∠SNB', ({ pointMap }) => triangleAngle(pointMap, ['S', 'N', 'B'])),
  'ANB': makeDegSpec(['S', 'N', 'A', 'B'], '∠SNA - ∠SNB', ({ pointMap }) => triangleAngle(pointMap, ['S', 'N', 'A']) - triangleAngle(pointMap, ['S', 'N', 'B'])),
  'SND': makeDegSpec(['S', 'N', 'D'], '∠SND', ({ pointMap }) => triangleAngle(pointMap, ['S', 'N', 'D'])),
  'FH-NPo': makeDegSpec(['Pog', 'N', 'Po', 'Or'], 'Ft(Pog,N,Po,Or)', ({ pointMap }) => lineAngle(pointMap, ['Pog', 'N', 'Po', 'Or'])),
  'NA-APo': makeDegSpec(['N', 'A', 'A', 'Pog'], 'Ft(N,A,A,Pog)', ({ pointMap }) => lineAngle(pointMap, ['N', 'A', 'A', 'Pog'])),
  'AB-NPo': makeDegSpec(['B', 'A', 'Pog', 'N'], 'Ft(B,A,Pog,N)', ({ pointMap }) => lineAngle(pointMap, ['B', 'A', 'Pog', 'N'])),
  'FH-MP': makeDegSpec(['Po', 'Or', 'Tpl', 'Me'], 'Ft(Po,Or,Tpl,Me)', ({ pointMap }) => lineAngle(pointMap, ['Po', 'Or', 'Tpl', 'Me'])),
  'SGn-FH': makeDegSpec(['Po', 'Or', 'S', 'Gn'], 'Ft(Po,Or,S,Gn)', ({ pointMap }) => lineAngle(pointMap, ['Po', 'Or', 'S', 'Gn'])),
  'OP-FH': makeDegSpec(['Po', 'Or', 'post_occlusal_point', 'ant_occlusal_point'], 'Ft(Po,Or,post_occlusal_point,ant_occlusal_point)', ({ pointMap }) => lineAngle(pointMap, ['Po', 'Or', 'post_occlusal_point', 'ant_occlusal_point'])),
  'U1-L1': makeDegSpec(['L1A', 'L1', 'U1A', 'U1'], 'Ft(L1A,L1,U1A,U1)', ({ pointMap }) => lineAngle(pointMap, ['L1A', 'L1', 'U1A', 'U1'])),
  'L1-OP': makeDegSpec(['post_occlusal_point', 'ant_occlusal_point', 'L1', 'L1A'], 'Ft(post_occlusal_point,ant_occlusal_point,L1,L1A)', ({ pointMap }) => lineAngle(pointMap, ['post_occlusal_point', 'ant_occlusal_point', 'L1', 'L1A'])),
  'U1-APo(mm)': makeMmSpec(['A', 'Pog', 'U1'], 'In(A,Pog,U1)', ({ pointMap, scale }) => pointLineDistanceMm(pointMap, ['A', 'Pog'], 'U1', scale)),
  'L1-MP': makeDegSpec(['Tpl', 'Me', 'L1', 'L1A'], 'Ft(Tpl,Me,L1,L1A)', ({ pointMap }) => lineAngle(pointMap, ['Tpl', 'Me', 'L1', 'L1A'])),
  'Pog-NB(mm)': makeMmSpec(['N', 'B', 'Pog'], 'Pog 到 NB 的垂距', ({ pointMap, scale }) => pointLineDistanceMm(pointMap, ['N', 'B'], 'Pog', scale)),
  'OP-SN': makeDegSpec(['S', 'N', 'post_occlusal_point', 'ant_occlusal_point'], 'Ft(S,N,post_occlusal_point,ant_occlusal_point)', ({ pointMap }) => lineAngle(pointMap, ['S', 'N', 'post_occlusal_point', 'ant_occlusal_point'])),
  'GoGn-SN': makeDegSpec(['S', 'N', 'Go', 'Gn'], 'Ft(S,N,Go,Gn)', ({ pointMap }) => lineAngle(pointMap, ['S', 'N', 'Go', 'Gn'])),
  'SE(mm)': makeMmSpec(['S', 'N', 'Pcd'], 'S 到 Pcd 在 SN 上投影点的距离', ({ pointMap, scale }) => projectedDistanceMm(pointMap, ['S', 'N'], 'S', 'Pcd', scale)),
  'SL(mm)': makeMmSpec(['S', 'N', 'Pog'], 'S 到 Pog 在 SN 上投影点的距离', ({ pointMap, scale }) => projectedDistanceMm(pointMap, ['S', 'N'], 'S', 'Pog', scale)),
  'U1-NA(mm)': makeMmSpec(['N', 'A', 'U1'], 'In(N,A,U1)', ({ pointMap, scale }) => pointLineDistanceMm(pointMap, ['N', 'A'], 'U1', scale)),
  'U1-NA': makeDegSpec(['U1A', 'U1', 'N', 'A'], 'Ft(U1A,U1,N,A)', ({ pointMap }) => lineAngle(pointMap, ['U1A', 'U1', 'N', 'A'])),
  'L1-NB(mm)': makeMmSpec(['N', 'B', 'L1'], 'In(N,B,L1)', ({ pointMap, scale }) => pointLineDistanceMm(pointMap, ['N', 'B'], 'L1', scale)),
  'L1-NB': makeDegSpec(['B', 'N', 'L1A', 'L1'], 'Ft(B,N,L1A,L1)', ({ pointMap }) => lineAngle(pointMap, ['B', 'N', 'L1A', 'L1'])),
  'U1-SN': makeDegSpec(['U1A', 'U1', 'N', 'S'], 'Ft(U1A,U1,N,S)', ({ pointMap }) => {
    const value = lineAngle(pointMap, ['U1A', 'U1', 'N', 'S']);
    return value < 0 ? 360 + value : value;
  }),
  'MP-SN': makeDegSpec(['S', 'N', 'Tpl', 'Me'], 'Ft(S,N,Tpl,Me)', ({ pointMap }) => lineAngle(pointMap, ['S', 'N', 'Tpl', 'Me'])),
  'UL-EP(mm)': makeMmSpec(['Prn', "Pog'", 'Ls'], "Vr(Prn,Pog',Ls)", ({ pointMap, scale }) => signedVrMm(pointMap, ['Prn', "Pog'"], 'Ls', scale)),
  'LL-EP(mm)': makeMmSpec(['Prn', "Pog'", 'LL'], "Vr(Prn,Pog',LL)", ({ pointMap, scale }) => signedVrMm(pointMap, ['Prn', "Pog'"], 'LL', scale)),
  'NBa-PtGn': makeDegSpec(['Pt', 'Gn', 'N', 'Ba'], 'Ft(Pt,Gn,N,Ba)', ({ pointMap }) => lineAngle(pointMap, ['Pt', 'Gn', 'N', 'Ba'])),
  'MP-NPo': makeDegSpec(['N', 'Pog', 'Tpl', 'Me'], '-Ft(N,Pog,Tpl,Me)', ({ pointMap }) => -lineAngle(pointMap, ['N', 'Pog', 'Tpl', 'Me'])),
  'ANS-Xi-Pm': makeDegSpec(['ANS', 'Xi', 'PM'], 'vr(ANS,Xi,PM)', ({ pointMap }) => triangleAngle(pointMap, ['ANS', 'Xi', 'PM'])),
  'Dc-Xi-Pm': makeDegSpec(['PM', 'Xi', 'DC'], 'Ft(PM,Xi,Xi,DC)', ({ pointMap }) => lineAngle(pointMap, ['PM', 'Xi', 'Xi', 'DC'])),
  'A-NPo(mm)': makeMmSpec(['N', 'Pog', 'A'], 'Vr(N,Pog,A)', ({ pointMap, scale }) => signedVrMm(pointMap, ['N', 'Pog'], 'A', scale)),
  'L1-APo(mm)': makeMmSpec(['A', 'Pog', 'L1'], 'In(A,Pog,L1)', ({ pointMap, scale }) => pointLineDistanceMm(pointMap, ['A', 'Pog'], 'L1', scale)),
  'L1-APo': makeDegSpec(['A', 'Pog', 'L1', 'L1A'], 'Ft(A,Pog,L1,L1A)', ({ pointMap }) => lineAngle(pointMap, ['A', 'Pog', 'L1', 'L1A'])),
  'U6-PtV(mm)': makeMmSpec(['Ptm', 'U6D', 'Po', 'Or'], 'Ptm 与 U6D 在 FH 上投影距离', ({ pointMap, scale }) => projectedDistanceMm(pointMap, ['Po', 'Or'], 'Ptm', 'U6D', scale)),
  'L1-FH': makeDegSpec(['L1A', 'L1', 'Po', 'Or'], 'Ft(L1A,L1,Po,Or)', ({ pointMap }) => lineAngle(pointMap, ['L1A', 'L1', 'Po', 'Or'])),
  'AO-BO(mm)': makeMmSpec(['A', 'B', 'post_occlusal_point', 'ant_occlusal_point'], 'A、B 在咬合平面投影前后距离', ({ pointMap, scale }) => {
    const aProjection = projectionPoint(pointMap, ['post_occlusal_point', 'ant_occlusal_point'], 'A');
    const bProjection = projectionPoint(pointMap, ['post_occlusal_point', 'ant_occlusal_point'], 'B');
    const magnitude = distanceBetweenPoints(aProjection, bProjection) * scale.mmPerPx;
    return aProjection.x < bProjection.x ? -magnitude : magnitude;
  }),
  'Z-Angle': makeDegSpec(['Po', 'Or', "Pog'", 'LL', 'Ls'], 'max(-Ft(Po,Or,Pog\',LL), -Ft(Po,Or,Pog\',Ls))', ({ pointMap }) => {
    const withLowerLip = -lineAngle(pointMap, ['Po', 'Or', "Pog'", 'LL']);
    const withStomion = -lineAngle(pointMap, ['Po', 'Or', "Pog'", 'Ls']);
    return Math.max(withLowerLip, withStomion);
  }),
  'Upper thickness': makeMmSpec(['Ls', 'UFa'], 'bt(Ls,UFa)', ({ pointMap, scale }) => pointDistanceMm(pointMap, ['Ls', 'UFa'], scale)),
  "Pog'-NB(mm)": makeMmSpec(["Pog'", 'N', 'B'], "Pog' 到 NB 的垂距", ({ pointMap, scale }) => pointLineDistanceMm(pointMap, ['N', 'B'], "Pog'", scale)),
  "Ar-Go'(mm)": makeMmSpec(['Ar', "Go'"], "bt(Ar,Go')", ({ pointMap, scale }) => pointDistanceMm(pointMap, ['Ar', "Go'"], scale)),
  'Me-PP(mm)': makeMmSpec(['PNS', 'ANS', 'Me'], 'In(PNS,ANS,Me)', ({ pointMap, scale }) => pointLineDistanceMm(pointMap, ['PNS', 'ANS'], 'Me', scale)),
  "Ar-Go'/Me-PP(%)": makePercentSpec(['Ar', "Go'", 'PNS', 'ANS', 'Me'], "Ar-Go' / Me-PP × 100", ({ pointMap, scale }) => {
    const numerator = pointDistanceMm(pointMap, ['Ar', "Go'"], scale);
    const denominator = pointLineDistanceMm(pointMap, ['PNS', 'ANS'], 'Me', scale);
    return denominator ? (numerator / denominator) * 100 : Number.NaN;
  }),
  'A-Np(mm)': makeMmSpec(['Po', 'Or', 'N', 'A'], 'A 相对 N 垂线的前后距离', ({ pointMap, scale }) => {
    const magnitude = projectedDistanceMm(pointMap, ['Po', 'Or'], 'N', 'A', scale);
    return getPoint(pointMap, 'N').x - getPoint(pointMap, 'A').x >= 0 ? magnitude : -magnitude;
  }),
  'Pog-Np(mm)': makeMmSpec(['Po', 'Or', 'Pog', 'N'], 'Pog 相对 N 垂线的前后距离', ({ pointMap, scale }) => {
    const magnitude = projectedDistanceMm(pointMap, ['Po', 'Or'], 'Pog', 'N', scale);
    return getPoint(pointMap, 'Pog').x - getPoint(pointMap, 'N').x >= 0 ? magnitude : -magnitude;
  }),
  'Co-A(mm)': makeMmSpec(['Co', 'A'], 'bt(Co,A)', ({ pointMap, scale }) => pointDistanceMm(pointMap, ['Co', 'A'], scale)),
  'Co-Gn(mm)': makeMmSpec(['Co', 'Gn'], 'bt(Co,Gn)', ({ pointMap, scale }) => pointDistanceMm(pointMap, ['Co', 'Gn'], scale)),
  'ANS-Me(mm)': makeMmSpec(['ANS', 'Me', 'Po', 'Or'], 'ANS、Me 到 FH 垂距之差', ({ pointMap, scale }) => {
    const ansDistance = perpendicularDistanceToLine(getPoint(pointMap, 'ANS'), getPoint(pointMap, 'Po'), getPoint(pointMap, 'Or')) * scale.mmPerPx;
    const meDistance = perpendicularDistanceToLine(getPoint(pointMap, 'Me'), getPoint(pointMap, 'Po'), getPoint(pointMap, 'Or')) * scale.mmPerPx;
    return meDistance - ansDistance;
  }),
  'U1-A(mm)': makeMmSpec(['A', 'U1'], 'U1.x - A.x', ({ pointMap, scale }) => (getPoint(pointMap, 'U1').x - getPoint(pointMap, 'A').x) * scale.mmPerPx),
  'L1-APog(mm)': makeMmSpec(['A', 'Pog', 'L1'], 'In(A,Pog,L1)', ({ pointMap, scale }) => pointLineDistanceMm(pointMap, ['A', 'Pog'], 'L1', scale)),
  'N-S-Ar': makeDegSpec(['N', 'S', 'Ar'], 'vr(N,S,Ar)', ({ pointMap }) => triangleAngle(pointMap, ['N', 'S', 'Ar'])),
  "S-Ar-Go'": makeDegSpec(['S', 'Ar', "Go'"], "vr(S,Ar,Go')", ({ pointMap }) => triangleAngle(pointMap, ['S', 'Ar', "Go'"])),
  "Ar-Go'-Me": makeDegSpec(['Ar', "Go'", 'Me'], "vr(Ar,Go',Me)", ({ pointMap }) => triangleAngle(pointMap, ['Ar', "Go'", 'Me'])),
  "Ar-Go'-N": makeDegSpec(['Ar', "Go'", 'N'], "vr(Ar,Go',N)", ({ pointMap }) => triangleAngle(pointMap, ['Ar', "Go'", 'N'])),
  "N-Go'-Me": makeDegSpec(['N', "Go'", 'Me'], "vr(N,Go',Me)", ({ pointMap }) => triangleAngle(pointMap, ['N', "Go'", 'Me'])),
  'Sum(S+Ar+Go)': makeDegSpec(['N', 'S', 'Ar', "Go'", 'Me'], 'vr(N,S,Ar)+vr(S,Ar,Go\')+vr(Ar,Go\',Me)', ({ pointMap }) => (
    triangleAngle(pointMap, ['N', 'S', 'Ar'])
    + triangleAngle(pointMap, ['S', 'Ar', "Go'"])
    + triangleAngle(pointMap, ['Ar', "Go'", 'Me'])
  )),
  'S-N(mm)': makeMmSpec(['S', 'N'], 'bt(S,N)', ({ pointMap, scale }) => pointDistanceMm(pointMap, ['S', 'N'], scale)),
  'Ar-S(mm)': makeMmSpec(['S', 'Ar'], 'bt(S,Ar)', ({ pointMap, scale }) => pointDistanceMm(pointMap, ['S', 'Ar'], scale)),
  "Go'-Me(mm)": makeMmSpec(["Go'", 'Me'], "bt(Go',Me)", ({ pointMap, scale }) => pointDistanceMm(pointMap, ["Go'", 'Me'], scale)),
  'N-Me(mm)': makeMmSpec(['N', 'Me'], 'bt(N,Me)', ({ pointMap, scale }) => pointDistanceMm(pointMap, ['N', 'Me'], scale)),
  "S-Go'(mm)": makeMmSpec(['S', "Go'"], "bt(S,Go')", ({ pointMap, scale }) => pointDistanceMm(pointMap, ['S', "Go'"], scale)),
  'N-Go': makeMmSpec(['N', 'Go'], 'bt(N,Go)', ({ pointMap, scale }) => pointDistanceMm(pointMap, ['N', 'Go'], scale)),
  'S-Me': makeMmSpec(['S', 'Me'], 'bt(S,Me)', ({ pointMap, scale }) => pointDistanceMm(pointMap, ['S', 'Me'], scale)),
  "S-Ar/Ar-Go'(%)": makePercentSpec(['S', 'Ar', "Go'"], "S-Ar / Ar-Go' × 100", ({ pointMap, scale }) => {
    const numerator = pointDistanceMm(pointMap, ['S', 'Ar'], scale);
    const denominator = pointDistanceMm(pointMap, ['Ar', "Go'"], scale);
    return denominator ? (numerator / denominator) * 100 : Number.NaN;
  }),
  "Go'-Me/S-N'(%)": makePercentSpec(["Go'", 'Me', 'S', 'N'], "Go'-Me / S-N × 100", ({ pointMap, scale }) => {
    const numerator = pointDistanceMm(pointMap, ["Go'", 'Me'], scale);
    const denominator = pointDistanceMm(pointMap, ['S', 'N'], scale);
    return denominator ? (numerator / denominator) * 100 : Number.NaN;
  }),
  "S-Go'/N-Me(%)": makePercentSpec(['N', 'Me', 'S', "Go'"], "S-Go' / N-Me × 100", ({ pointMap, scale }) => {
    const numerator = pointDistanceMm(pointMap, ['S', "Go'"], scale);
    const denominator = pointDistanceMm(pointMap, ['N', 'Me'], scale);
    return denominator ? (numerator / denominator) * 100 : Number.NaN;
  }),
  'SN-SGn': makeDegSpec(['S', 'N', 'Gn'], 'Ft(S,N,S,Gn)', ({ pointMap }) => lineAngle(pointMap, ['S', 'N', 'S', 'Gn'])),
  'SN-NPo': makeDegSpec(['S', 'N', 'Pog'], 'vr(S,N,Pog)', ({ pointMap }) => triangleAngle(pointMap, ['S', 'N', 'Pog'])),
};

function buildFrameworkReports(pointMap, payload) {
  const scale = buildMeasurementScale(payload);
  const workingPointMap = new Map(pointMap);
  ensureWebDerivedPoints(workingPointMap);
  const geometry = buildCommonGeometry(workingPointMap);
  const reports = {};

  for (const framework of WEB_FRAMEWORK_DATA) {
    const items = [];
    const involvedLandmarks = new Set();

    for (const [calculationId, label, referenceMean, referenceSd] of framework.items) {
      const definition = FRAMEWORK_CALCULATION_REGISTRY[calculationId];
      const unit = definition?.unit || inferFrameworkUnit(calculationId);
      const reference = formatFrameworkReference(referenceMean, referenceSd, unit);
      const normalMin = Number.isFinite(referenceMean) && Number.isFinite(referenceSd) ? referenceMean - referenceSd : null;
      const normalMax = Number.isFinite(referenceMean) && Number.isFinite(referenceSd) ? referenceMean + referenceSd : null;
      const landmarks = definition?.landmarks || [];
      for (const landmark of landmarks) {
        involvedLandmarks.add(landmark);
      }

      try {
        if (!definition) {
          throw new Error('尚未实现该网页项目公式');
        }
        if (unit === 'mm' && !scale.mmPerPx) {
          throw new Error('缺少有效标尺，无法换算毫米');
        }
        const value = definition.compute({ pointMap: workingPointMap, scale, geometry });
        if (!Number.isFinite(value)) {
          throw new Error('计算结果不是有效数值');
        }
        items.push(buildFrameworkItem({
          code: calculationId,
          label,
          unit,
          value,
          reference,
          referenceMean,
          referenceSd,
          normalMin,
          normalMax,
          landmarks,
          formula: definition.formula,
        }));
      } catch (error) {
        items.push(buildUnsupportedFrameworkItem({
          code: calculationId,
          label,
          landmarks,
          formula: definition?.formula || calculationId,
          reference,
          referenceMean,
          referenceSd,
          reason: error instanceof Error ? error.message.replace(/^Missing ceph landmark:\s*/, '缺少 ') : String(error),
        }));
      }
    }

    const supportedItems = items.filter((item) => item.status === 'supported');
    const unsupportedItems = items.filter((item) => item.status !== 'supported');
    reports[framework.code] = {
      code: framework.code,
      label: framework.label,
      note: `输出网页中 ${framework.label} 的完整项目原始数值。`,
      source: 'webpage-full-set',
      scale,
      status: unsupportedItems.length ? (supportedItems.length ? 'partial' : 'unsupported') : 'supported',
      supportedItemCount: supportedItems.length,
      unsupportedItemCount: unsupportedItems.length,
      items,
      rawLandmarks: Object.fromEntries(
        [...involvedLandmarks]
          .filter((landmark) => workingPointMap.has(landmark))
          .map((landmark) => {
            const point = workingPointMap.get(landmark);
            return [landmark, {
              landmark: point.landmark,
              key: point.key,
              x: point.x,
              y: point.y,
            }];
          }),
      ),
    };
  }

  return reports;
}

function buildMetric(code, value) {
  const config = METRIC_DEFINITIONS[code];
  const rounded = round1(value);
  let tone = 'success';
  if (rounded < config.normalMin || rounded > config.normalMax) {
    const overflow = rounded < config.normalMin
      ? config.normalMin - rounded
      : rounded - config.normalMax;
    tone = overflow >= 3 ? 'danger' : 'warn';
  }
  return {
    code,
    label: config.label,
    value: rounded,
    valueText: `${rounded}°`,
    reference: config.reference,
    tone,
  };
}

function buildMetrics(pointMap) {
  const metrics = [];
  const metricMap = {};
  const unsupported = [];

  for (const code of METRIC_ORDER) {
    const requiredKeys = METRIC_DEFINITIONS[code].requiredKeys;
    const missingKeys = requiredKeys.filter((key) => !pointMap.has(key));
    if (missingKeys.length) {
      unsupported.push({ code, reason: `缺少 ${missingKeys.join('、')}` });
      continue;
    }

    let metric;
    if (code === 'SNA') {
      metric = buildMetric(code, angleAt(getPoint(pointMap, 'S'), getPoint(pointMap, 'N'), getPoint(pointMap, 'A')));
    } else if (code === 'SNB') {
      metric = buildMetric(code, angleAt(getPoint(pointMap, 'S'), getPoint(pointMap, 'N'), getPoint(pointMap, 'B')));
    } else if (code === 'ANB') {
      metric = buildMetric(
        code,
        angleAt(getPoint(pointMap, 'S'), getPoint(pointMap, 'N'), getPoint(pointMap, 'A'))
          - angleAt(getPoint(pointMap, 'S'), getPoint(pointMap, 'N'), getPoint(pointMap, 'B')),
      );
    } else if (code === 'GoGn-SN') {
      metric = buildMetric(code, acuteAngleBetweenLines(
        getPoint(pointMap, 'Go'),
        getPoint(pointMap, 'Gn'),
        getPoint(pointMap, 'S'),
        getPoint(pointMap, 'N'),
      ));
    } else if (code === 'FMA') {
      metric = buildMetric(code, acuteAngleBetweenLines(
        getPoint(pointMap, 'Po'),
        getPoint(pointMap, 'Or'),
        getPoint(pointMap, 'Go'),
        getPoint(pointMap, 'Me'),
      ));
    } else if (code === 'U1-SN') {
      metric = buildMetric(code, 180 - acuteAngleBetweenLines(
        getPoint(pointMap, 'U1R'),
        getPoint(pointMap, 'U1T'),
        getPoint(pointMap, 'S'),
        getPoint(pointMap, 'N'),
      ));
    } else {
      metric = buildMetric(code, acuteAngleBetweenLines(
        getPoint(pointMap, 'L1R'),
        getPoint(pointMap, 'L1T'),
        getPoint(pointMap, 'Go'),
        getPoint(pointMap, 'Me'),
      ));
    }

    metrics.push(metric);
    metricMap[code] = metric;
  }

  return { metrics, metricMap, unsupported };
}

function buildRecognition(landmarks) {
  const confidences = landmarks
    .map((item) => item.confidence)
    .filter((value) => typeof value === 'number' && Number.isFinite(value));
  const confidence = confidences.length
    ? round1((confidences.reduce((sum, value) => sum + value, 0) / confidences.length) * 100)
    : null;

  return {
    identified: landmarks.length,
    total: landmarks.length,
    confidence,
    statusText: confidence === null
      ? '自动点定完成，未返回置信度'
      : confidence >= 90
        ? '自动点定完成'
        : '自动点定完成，建议重点复核',
  };
}

function buildRiskLabel(metricMap) {
  const anb = metricMap.ANB;
  if (anb) {
    if (anb.value >= 4.8) return '骨性 II 类倾向';
    if (anb.value <= 0.5) return '骨性 III 类倾向';
  }
  if ((metricMap['GoGn-SN'] && metricMap['GoGn-SN'].value >= 36) || (metricMap.FMA && metricMap.FMA.value >= 29)) {
    return '高角倾向';
  }
  if (metricMap['U1-SN'] && metricMap['U1-SN'].value >= 105) {
    return '上前牙唇倾';
  }
  if (anb || metricMap.FMA || metricMap['GoGn-SN']) {
    return '骨面型基本协调';
  }
  return '需结合人工复核判断';
}

function buildInsight(metricMap, recognition, unsupportedMetrics) {
  const messages = [];
  const anb = metricMap.ANB;
  if (anb) {
    if (anb.value >= 4.8) {
      messages.push('ANB 偏大，提示上颌前突或下颌后缩趋势。');
    } else if (anb.value <= 0.5) {
      messages.push('ANB 偏小，需警惕 III 类骨性关系。');
    } else {
      messages.push('颌间前后关系接近常用参考范围。');
    }
  } else {
    messages.push('当前点位集不足以完整计算颌间前后关系，需结合人工定点补齐。');
  }

  const u1sn = metricMap['U1-SN'];
  if (u1sn && u1sn.value >= 105) {
    messages.push('上前牙唇倾较明显，建议关注切牙代偿。');
  }

  const gognsn = metricMap['GoGn-SN'];
  const fma = metricMap.FMA;
  if ((gognsn && gognsn.value >= 36) || (fma && fma.value >= 29)) {
    messages.push('垂直向角度偏大，建议重点复核高角风险。');
  } else if ((gognsn && gognsn.value <= 28) || (fma && fma.value <= 21)) {
    messages.push('垂直向角度偏低，需结合低角面型一起判断。');
  }

  if (recognition.confidence === null) {
    messages.push('本次结果未返回点位置信度，建议人工复核关键点。');
  } else if (recognition.confidence < 90) {
    messages.push('点位平均置信度偏低，建议人工重点复核关键点。');
  } else {
    messages.push('本轮自动点定结果适合直接进入人工复核与指标解读。');
  }

  if (unsupportedMetrics.length) {
    messages.push(`当前结果暂不支持 ${unsupportedMetrics.map((item) => item.code).join('、')} 等依赖缺失点位的指标。`);
  }

  return messages.join('');
}

function buildLateraAnalysis(payload) {
  const normalizedLandmarks = collectLateraLandmarks(payload);
  if (!normalizedLandmarks.length) {
    return null;
  }

  const pointMap = new Map();
  for (const point of normalizedLandmarks) {
    upsertPoint(pointMap, point);
  }

  const uniqueLandmarks = Array.from(pointMap.values()).sort((left, right) => left.key.localeCompare(right.key));
  const { metrics, metricMap, unsupported } = buildMetrics(pointMap);
  const recognition = buildRecognition(uniqueLandmarks);
  const frameworkReports = buildFrameworkReports(pointMap, payload);
  const scale = buildMeasurementScale(payload);

  return {
    landmarks: uniqueLandmarks,
    recognition,
    scale,
    riskLabel: buildRiskLabel(metricMap),
    insight: buildInsight(metricMap, recognition, unsupported),
    metrics,
    unsupportedMetricCodes: unsupported.map((item) => item.code),
    supportedMetricCodes: metrics.map((item) => item.code),
    frameworkChoices: FRAMEWORK_CHOICES,
    frameworkReports,
  };
}

function summarizeAnalysis(analysis) {
  if (!analysis) {
    return {};
  }
  return {
    supportedMetrics: analysis.supportedMetricCodes,
    unsupportedMetrics: analysis.unsupportedMetricCodes,
    metricValues: Object.fromEntries(analysis.metrics.map((metric) => [metric.code, metric.value])),
    riskLabel: analysis.riskLabel,
    frameworkChoices: analysis.frameworkChoices || [],
    supportedFrameworks: Object.values(analysis.frameworkReports || {})
      .filter((item) => item.status === 'supported' || item.status === 'partial')
      .map((item) => item.label),
  };
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function inferImageDimensions(fileBuffer, mimeType) {
  if (!Buffer.isBuffer(fileBuffer)) {
    return null;
  }

  if (mimeType === 'image/png' && fileBuffer.length >= 24) {
    return {
      width: fileBuffer.readUInt32BE(16),
      height: fileBuffer.readUInt32BE(20),
    };
  }

  if ((mimeType === 'image/jpeg' || mimeType === 'image/jpg') && fileBuffer.length >= 4) {
    let offset = 2;
    while (offset < fileBuffer.length) {
      if (fileBuffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = fileBuffer[offset + 1];
      offset += 2;
      if (marker === 0xd8 || marker === 0xd9) {
        continue;
      }
      if (offset + 2 > fileBuffer.length) {
        break;
      }
      const segmentLength = fileBuffer.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > fileBuffer.length) {
        break;
      }
      const isSofMarker = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isSofMarker && offset + 7 <= fileBuffer.length) {
        return {
          height: fileBuffer.readUInt16BE(offset + 3),
          width: fileBuffer.readUInt16BE(offset + 5),
        };
      }
      offset += segmentLength;
    }
  }

  if (mimeType === 'image/gif' && fileBuffer.length >= 10) {
    return {
      width: fileBuffer.readUInt16LE(6),
      height: fileBuffer.readUInt16LE(8),
    };
  }

  if (mimeType === 'image/bmp' && fileBuffer.length >= 26) {
    return {
      width: Math.abs(fileBuffer.readInt32LE(18)),
      height: Math.abs(fileBuffer.readInt32LE(22)),
    };
  }

  if (mimeType === 'image/webp' && fileBuffer.length >= 30 && fileBuffer.toString('ascii', 0, 4) === 'RIFF' && fileBuffer.toString('ascii', 8, 12) === 'WEBP') {
    const chunkType = fileBuffer.toString('ascii', 12, 16);
    if (chunkType === 'VP8X' && fileBuffer.length >= 30) {
      const width = 1 + fileBuffer.readUIntLE(24, 3);
      const height = 1 + fileBuffer.readUIntLE(27, 3);
      return { width, height };
    }
  }

  return null;
}

function fallbackDimensionsFromLandmarks(landmarks) {
  if (!landmarks.length) {
    return { width: 1200, height: 900 };
  }
  const maxX = Math.max(...landmarks.map((item) => item.x));
  const maxY = Math.max(...landmarks.map((item) => item.y));
  return {
    width: Math.max(1200, Math.ceil(maxX + 120)),
    height: Math.max(900, Math.ceil(maxY + 120)),
  };
}

function buildAnnotatedSvg({
  imageDataUrl,
  width,
  height,
  landmarks,
  overlayData,
  analysis,
  analysisError,
}) {
  const panelWidth = 360;
  const svgWidth = width + panelWidth;
  const svgHeight = height;
  const pointRadius = clamp(Math.round(Math.min(width, height) / 220), 3, 6);
  const riskLabel = analysis?.riskLabel || '未生成测量结论';
  const metrics = analysis?.metrics || [];
  const confidenceText = analysis?.recognition?.confidence == null
    ? 'N/A'
    : `${analysis.recognition.confidence}%`;
  const headPoints = overlayData?.headPoints?.length ? overlayData.headPoints : landmarks;
  const rulerPoints = overlayData?.rulerPoints || [];
  const spineSections = overlayData?.spineSections || [];
  const spinePoints = spineSections.flatMap((section) => section.points);
  const overlayPoints = [...headPoints, ...rulerPoints, ...spinePoints];
  const pointLookup = buildPointLookup(overlayPoints);
  const toothFillShapes = buildToothFillShapes(pointLookup);
  const panelLines = [
    `HYF Ceph`,
    `Risk: ${riskLabel}`,
    `Points: ${overlayPoints.length}`,
    `Confidence: ${confidenceText}`,
    `Display: image / tooth fill / outline / key / aux`,
    '',
    ...metrics.map((metric) => `${metric.code}: ${metric.valueText}`),
  ];

  if (analysisError) {
    panelLines.push('', `Metric error: ${analysisError}`);
  } else if (analysis?.unsupportedMetricCodes?.length) {
    panelLines.push('', `Unsupported: ${analysis.unsupportedMetricCodes.join(', ')}`);
  }

  const contourElements = WEBPAGE_LINE_TEMPLATES
    .flatMap((template) => buildTemplateSegments(template, pointLookup).map((points) => ({ template, points })))
    .map(({ template, points }) => {
      const pathData = buildSmoothPath(points, Boolean(template.closePath));
      if (!pathData) {
        return '';
      }
      const dasharray = template.dasharray ? ` stroke-dasharray="${template.dasharray}"` : '';
      const opacity = template.opacity ?? 0.92;
      return `<path d="${pathData}" fill="none" stroke="${template.stroke}" stroke-width="${template.width}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}"${dasharray} />`;
    })
    .join('');

  const toothFillElements = toothFillShapes
    .map((shape) => {
      const pathData = buildSmoothPath(shape.points, true);
      if (!pathData) {
        return '';
      }
      return `<path d="${pathData}" fill="${shape.fill}" fill-opacity="${shape.fillOpacity}" stroke="${shape.stroke}" stroke-opacity="${shape.strokeOpacity}" stroke-width="${shape.strokeWidth}" stroke-linecap="round" stroke-linejoin="round" />`;
    })
    .join('');

  const headPointElements = headPoints.map((point) => {
    const pointType = classifyHeadPoint(point);
    const color = pointType === 'primary'
      ? '#f97316'
      : pointType === 'keypoint'
        ? '#fde047'
        : '#38bdf8';
    const stroke = pointType === 'primary'
      ? '#7c2d12'
      : pointType === 'keypoint'
        ? '#713f12'
        : '#0f172a';
    const radius = pointType === 'primary'
      ? pointRadius + 1
      : pointType === 'keypoint'
        ? pointRadius
        : Math.max(2.2, pointRadius - 0.6);

    return `<circle cx="${point.x}" cy="${point.y}" r="${radius}" fill="${color}" stroke="${stroke}" stroke-width="1.3" opacity="${pointType === 'auxiliary' ? '0.94' : '1'}" />`;
  }).join('');

  const rulerPointElements = rulerPoints
    .map((point) => `<circle cx="${point.x}" cy="${point.y}" r="${pointRadius}" fill="#34d399" stroke="#064e3b" stroke-width="1.3" />`)
    .join('');

  const spinePointElements = spineSections
    .flatMap((section, index) => section.points.map((point) => {
      const hue = 270 + index * 12;
      return `<circle cx="${point.x}" cy="${point.y}" r="${Math.max(2, pointRadius - 1)}" fill="hsl(${hue} 88% 72%)" stroke="#1f2937" stroke-width="1.1" opacity="0.95" />`;
    }))
    .join('');

  const panelText = panelLines
    .map((line, index) => {
      const safeLine = escapeXml(line);
      const y = 42 + index * 24;
      const fontWeight = index === 0 ? '700' : '500';
      return `<text x="${width + 20}" y="${y}" font-family="Menlo, Consolas, monospace" font-size="16" font-weight="${fontWeight}" fill="#e5e7eb">${safeLine}</text>`;
    })
    .join('');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">`,
    `<rect width="${svgWidth}" height="${svgHeight}" fill="#0f172a" />`,
    `<image href="${imageDataUrl}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="none" />`,
    `<rect x="${width}" y="0" width="${panelWidth}" height="${height}" fill="#111827" opacity="0.92" />`,
    `<g>${toothFillElements}</g>`,
    `<g>${contourElements}</g>`,
    `<g>${headPointElements}${rulerPointElements}${spinePointElements}</g>`,
    `<g>${panelText}</g>`,
    `</svg>`,
  ].join('');
}

async function writeAnnotatedSvg({
  imagePath,
  imageBuffer,
  imageMimeType,
  landmarks,
  overlayData,
  analysis,
  analysisError,
  outputPath,
}) {
  const inferredDimensions = inferImageDimensions(imageBuffer, imageMimeType);
  const { width, height } = inferredDimensions || fallbackDimensionsFromLandmarks(landmarks);
  const imageDataUrl = `data:${imageMimeType};base64,${Buffer.from(imageBuffer).toString('base64')}`;
  const svg = buildAnnotatedSvg({
    imageDataUrl,
    width,
    height,
    landmarks,
    overlayData,
    analysis,
    analysisError,
  });

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, svg, 'utf8');
  return path.resolve(outputPath);
}

async function convertSvgToPng(svgPath, pngPath) {
  await fs.mkdir(path.dirname(pngPath), { recursive: true });
  const attempts = [
    ['sips', ['-s', 'format', 'png', svgPath, '--out', pngPath]],
    ['magick', [svgPath, pngPath]],
    ['rsvg-convert', ['-o', pngPath, svgPath]],
  ];
  const failures = [];

  for (const [command, args] of attempts) {
    try {
      execFileSync(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return path.resolve(pngPath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push(`${command}: ${reason}`);
    }
  }

  throw new Error(`PNG conversion failed: ${failures.join(' | ')}`);
}

async function writeOutput(outputPath, data) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(data, null, 2));
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      image: { type: 'string' },
      output: { type: 'string' },
      token: { type: 'string' },
      'share-url': { type: 'string' },
      'current-case': { type: 'boolean', default: false },
      username: { type: 'string' },
      password: { type: 'string' },
      mgr: { type: 'boolean', default: false },
      'downloaded-image-output': { type: 'string' },
      'session-file': { type: 'string' },
      'bridge-file': { type: 'string' },
      'page-url': { type: 'string' },
      'api-base': { type: 'string' },
      'client-id': { type: 'string' },
      'x-app-key': { type: 'string' },
      'algorithm-name': { type: 'string', default: DEFAULT_ALGORITHM_NAME },
      'poll-ms': { type: 'string', default: '1000' },
      'timeout-seconds': { type: 'string', default: '180' },
      'force-refresh-algorithm-token': { type: 'boolean', default: false },
      'no-session-cache': { type: 'boolean', default: false },
      'annotated-output': { type: 'string' },
      'annotated-png-output': { type: 'string' },
      'api-key': { type: 'string' },
      'portal-base-url': { type: 'string' },
      'skip-portal-validation': { type: 'boolean', default: false },
      'no-annotated-svg': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    printHelp();
    return;
  }

  const requestedImagePath = values.image || positionals[0] || '';
  const explicitShareContext = values['share-url']
    ? parseLateraShareUrl(values['share-url'])
    : null;
  const bridgeFile = path.resolve(values['bridge-file'] || defaultBridgeFile());
  const localBridgeState = await readBridgeState(bridgeFile);
  const rawLocalBridgeContext = buildBridgeContext(localBridgeState);
  const localBridgeContext = isRecentBridgeContext(rawLocalBridgeContext) ? rawLocalBridgeContext : null;
  const wantsCurrentCase = values['current-case'] || (!requestedImagePath && !explicitShareContext);
  const portalBaseUrl = ensureTrailingSlash(values['portal-base-url'] || process.env.HYFCEPH_PORTAL_BASE_URL || DEFAULT_PORTAL_BASE_URL);
  const skipPortalValidation = values['skip-portal-validation'];
  const hyfApiKey = String(values['api-key'] || process.env.HYFCEPH_API_KEY || '').trim();
  if (!skipPortalValidation && !hyfApiKey) {
    throw new Error('Missing HYFCeph API Key. Please register first and provide --api-key or HYFCEPH_API_KEY.');
  }
  const portalValidation = skipPortalValidation
    ? null
    : await validatePortalApiKey({
      portalBaseUrl,
      apiKey: hyfApiKey,
    });
  const portalBridgePayload = wantsCurrentCase
    && !skipPortalValidation
    ? await fetchPortalBridgeCurrentCase({
      portalBaseUrl,
      apiKey: hyfApiKey,
    })
    : null;
  const portalBridgeContext = buildBridgeContext(portalBridgePayload?.currentCase || null);
  const caseContext = explicitShareContext || (wantsCurrentCase ? (portalBridgeContext || localBridgeContext) : null);

  if (!requestedImagePath && !caseContext) {
    printHelp();
    throw new Error('No image or current-case context was found. Open the case page once so the browser can sync it, or provide a local image.');
  }

  const pageUrl = new URL(values['page-url'] || caseContext?.pageUrl || portalBridgeContext?.pageUrl || localBridgeContext?.pageUrl || DEFAULT_PAGE_URL).toString();
  const apiBase = buildApiBase(pageUrl, values['api-base']);
  const callbackUrl = buildCallbackUrl(pageUrl);
  const appSettings = await fetchAppSettings(pageUrl);
  const clientId = values['client-id'] || appSettings.clientId;
  const xAppKey = values['x-app-key'] || appSettings.xAppKey;
  const sessionCacheEnabled = !values['no-session-cache'];
  const sessionFile = path.resolve(values['session-file'] || defaultSessionFile());
  const cachedSession = sessionCacheEnabled ? await readSessionCache(sessionFile) : null;
  const cachedToken = cachedSession?.token || '';

  const envToken = process.env.LATERA_TOKEN || process.env.XIAOLIU_TOKEN || '';
  let xiaoliutoken = values.token || envToken || caseContext?.token || portalBridgeContext?.token || localBridgeContext?.token || cachedToken || '';
  const username = values.username || process.env.LATERA_USERNAME || '';
  const password = values.password || process.env.LATERA_PASSWORD || '';
  let authSource = values.token
    ? 'cli-token'
    : envToken
      ? 'env-token'
      : caseContext?.source && caseContext?.token
        ? caseContext.source
        : explicitShareContext?.token
        ? 'share-url'
        : portalBridgeContext?.token
          ? portalBridgeContext.source || 'portal-bridge'
        : localBridgeContext?.token
          ? localBridgeContext.source || 'browser-bridge'
        : cachedToken
          ? 'session-cache'
          : 'login';

  if (!xiaoliutoken) {
    if (!username || !password) {
      throw new Error('No active session was found. Refresh the current browser case so it can sync to HYFCeph, or provide manual auth parameters.');
    }
    xiaoliutoken = await loginDoctor({
      apiBase,
      clientId,
      xAppKey,
      username,
      password,
      mgr: values.mgr,
    });
    authSource = 'login';
  }

  let algorithmToken;
  let algorithmBase;
  let algorithmAccessError = null;
  const shareFallbackToken = caseContext?.shareContext?.token
    && caseContext?.shareContext?.token !== xiaoliutoken
    ? caseContext.shareContext.token
    : '';

  try {
    ({ algorithmToken, algorithmBase } = await getAlgorithmAccess({
      apiBase,
      clientId,
      xAppKey,
      xiaoliutoken,
      force: values['force-refresh-algorithm-token'],
    }));
  } catch (error) {
    algorithmAccessError = error;
  }

  if ((!algorithmToken || !algorithmBase) && shareFallbackToken) {
    try {
      ({ algorithmToken, algorithmBase } = await getAlgorithmAccess({
        apiBase,
        clientId,
        xAppKey,
        xiaoliutoken: shareFallbackToken,
        force: values['force-refresh-algorithm-token'],
      }));
      xiaoliutoken = shareFallbackToken;
      authSource = 'share-url-fallback';
      algorithmAccessError = null;
    } catch (error) {
      algorithmAccessError = error;
    }
  }

  if (!algorithmToken || !algorithmBase) {
    const reason = algorithmAccessError instanceof Error ? algorithmAccessError.message : String(algorithmAccessError);
    if (authSource === 'session-cache') {
      throw new Error(`Stored session expired. Refresh the current browser case once and retry. ${reason}`);
    }
    if (['portal-bridge', 'browser-bridge', 'tampermonkey'].includes(String(caseContext?.source || ''))) {
      throw new Error(`Current browser session in bridge expired. Reopen the case page so it syncs again, or send a fresh share link. ${reason}`);
    }
    throw algorithmAccessError;
  }

  if (sessionCacheEnabled && xiaoliutoken) {
    await writeSessionCache(sessionFile, {
      token: xiaoliutoken,
      pageUrl,
      updatedAt: new Date().toISOString(),
      authSource,
      shareCase: caseContext ? {
        ptId: caseContext.ptId,
        ptVersion: caseContext.ptVersion,
        accountType: caseContext.accountType,
        lang: caseContext.lang,
      } : undefined,
    });
  }

  let resolvedImagePath = requestedImagePath ? path.resolve(requestedImagePath) : '';
  let imageSource = requestedImagePath ? 'local' : 'none';
  let downloadedFromShare = false;

  if (!values['dry-run']) {
    if (resolvedImagePath) {
      await fs.access(resolvedImagePath);
    } else {
      if (!caseContext?.ptId || !caseContext?.ptVersion) {
        throw new Error('The current case context is incomplete, so the lateral image could not be fetched automatically.');
      }

      const lateralImageUrl = await fetchSharedLateralImageUrl({
        apiBase,
        clientId,
        xAppKey,
        xiaoliutoken,
        ptId: caseContext.ptId,
        ptVersion: caseContext.ptVersion,
      });
      const downloadedImagePath = values['downloaded-image-output']
        || defaultDownloadedImagePath({
          ptId: caseContext.ptId,
          ptVersion: caseContext.ptVersion,
          imageUrl: lateralImageUrl,
        });
      const downloadResult = await downloadRemoteImage(lateralImageUrl, downloadedImagePath);
      resolvedImagePath = downloadResult.resolvedPath;
      imageSource = caseContext?.source || 'share-url';
      downloadedFromShare = true;
    }
  }

  const configSnapshot = {
    pageUrl,
    apiBase,
    algorithmBase,
    algorithmName: values['algorithm-name'],
    callbackUrl,
    portalBaseUrl,
    clientId,
    xAppKeySource: appSettings.source,
    hyfApiKeyOwner: portalValidation?.owner || null,
    authSource,
    imageSource,
    downloadedFromShare,
    sessionCacheEnabled,
    sessionCacheHit: authSource === 'session-cache',
    sessionFile: sessionCacheEnabled ? sessionFile : null,
    bridgeFile,
    bridgeStateHit: Boolean(localBridgeContext),
    bridgeCase: localBridgeContext ? {
      ptId: localBridgeContext.ptId,
      ptVersion: localBridgeContext.ptVersion,
      accountType: localBridgeContext.accountType,
      lang: localBridgeContext.lang,
      syncedAt: localBridgeContext.syncedAt,
      hasBridgeToken: Boolean(localBridgeContext.token),
      hasShareUrl: Boolean(localBridgeContext.shareUrl),
    } : null,
    portalBridgeHit: Boolean(portalBridgeContext),
    portalBridgeCase: portalBridgeContext ? {
      ptId: portalBridgeContext.ptId,
      ptVersion: portalBridgeContext.ptVersion,
      accountType: portalBridgeContext.accountType,
      lang: portalBridgeContext.lang,
      syncedAt: portalBridgeContext.syncedAt,
      hasBridgeToken: Boolean(portalBridgeContext.token),
      hasShareUrl: Boolean(portalBridgeContext.shareUrl),
    } : null,
    shareCase: explicitShareContext ? {
      ptId: explicitShareContext.ptId,
      ptVersion: explicitShareContext.ptVersion,
      accountType: explicitShareContext.accountType,
      lang: explicitShareContext.lang,
      hasShareToken: Boolean(explicitShareContext.token),
    } : null,
    hasUserToken: Boolean(xiaoliutoken),
    hasAlgorithmToken: Boolean(algorithmToken),
  };

  if (values['dry-run']) {
    console.log(JSON.stringify(configSnapshot, null, 2));
    return;
  }

  const imageMimeType = inferMimeType(resolvedImagePath);
  const fileBuffer = await fs.readFile(resolvedImagePath);
  const fileName = path.basename(resolvedImagePath);
  const fileBlob = new Blob([fileBuffer], { type: imageMimeType });

  if (!skipPortalValidation && hyfApiKey) {
    await notifyPortalSkillEvent({
      portalBaseUrl,
      apiKey: hyfApiKey,
      eventType: 'image_submission',
      imageName: fileName,
      imageSource,
    });
  }

  const uploadSignature = await fetchUploadSignature({
    algorithmBase,
    algorithmToken,
    algorithmName: values['algorithm-name'],
  });

  const { taskId, uploadPath } = await uploadImageToOss({
    uploadSignature,
    fileBlob,
    fileName,
    algorithmToken,
  });

  const createTaskResult = await createTask({
    algorithmBase,
    algorithmToken,
    algorithmName: values['algorithm-name'],
    taskId,
    callbackUrl,
    imageFilePath: uploadPath,
  });

  let resultIndex;
  if (createTaskResult?.data?.status === 'SUCCESS' && createTaskResult?.data?.result) {
    resultIndex = createTaskResult.data.result;
  } else {
    resultIndex = await pollTaskResult({
      algorithmBase,
      algorithmToken,
      taskId,
      pollMs: Number(values['poll-ms']),
      timeoutSeconds: Number(values['timeout-seconds']),
    });
  }

  const resolvedResult = await resolveResultPayload(resultIndex);
  let analysis = null;
  let analysisError = null;
  try {
    analysis = buildLateraAnalysis(resolvedResult?.payload);
  } catch (error) {
    analysisError = error instanceof Error ? error.message : String(error);
  }
  let annotatedSvgPath = null;
  let annotatedPngPath = null;
  let annotationError = null;
  const overlayData = collectOverlayData(resolvedResult?.payload);
  const landmarks = analysis?.landmarks || collectLateraLandmarks(resolvedResult?.payload);
  if (!values['no-annotated-svg'] && landmarks.length) {
    try {
      annotatedSvgPath = await writeAnnotatedSvg({
        imagePath: resolvedImagePath,
        imageBuffer: fileBuffer,
        imageMimeType,
        landmarks,
        overlayData,
        analysis,
        analysisError,
        outputPath: path.resolve(values['annotated-output'] || defaultAnnotatedSvgPath(resolvedImagePath)),
      });
      annotatedPngPath = await convertSvgToPng(
        annotatedSvgPath,
        path.resolve(values['annotated-png-output'] || defaultAnnotatedPngPath(resolvedImagePath)),
      );
    } catch (error) {
      annotationError = error instanceof Error ? error.message : String(error);
    }
  }
  const outputPath = path.resolve(values.output || defaultOutputPath(resolvedImagePath));
  const output = {
    imagePath: resolvedImagePath,
    outputCreatedAt: new Date().toISOString(),
    config: configSnapshot,
    task: {
      taskId,
      uploadPath,
      callbackUrl,
    },
    resultIndex,
    resultUrl: resolvedResult?.url || null,
    resultPayload: resolvedResult?.payload || null,
    analysisError,
    annotationError,
    annotatedSvgPath,
    annotatedPngPath,
    landmarks,
    analysis: analysis ? {
      recognition: analysis.recognition,
      scale: analysis.scale,
      riskLabel: analysis.riskLabel,
      insight: analysis.insight,
      metrics: analysis.metrics,
      unsupportedMetricCodes: analysis.unsupportedMetricCodes,
      supportedMetricCodes: analysis.supportedMetricCodes,
      frameworkChoices: analysis.frameworkChoices,
      frameworkReports: analysis.frameworkReports,
    } : null,
    summary: {
      ...summarizePayload(resolvedResult?.payload),
      ...summarizeAnalysis(analysis),
    },
  };

  await writeOutput(outputPath, output);

  console.log(JSON.stringify({
    outputPath,
    annotatedSvgPath,
    annotatedPngPath,
    taskId,
    resultUrl: output.resultUrl,
    analysisError,
    annotationError,
    summary: output.summary,
    metrics: output.analysis?.metrics || [],
  }, null, 2));
}

export {
  WEBPAGE_LINE_TEMPLATES,
  collectOverlayData,
  buildPointLookup,
  buildTemplateSegments,
  buildSmoothPath,
  buildSimilarityTransform,
  buildToothFillShapes,
};

function isDirectCliRun() {
  if (!process.argv[1]) {
    return false;
  }

  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isDirectCliRun()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
