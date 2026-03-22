import {
  WEBPAGE_LINE_TEMPLATES,
  buildPointLookup,
  buildSimilarityTransform,
  buildSmoothPath,
  buildTemplateSegments,
  buildToothFillShapes,
  collectOverlayData,
} from './hyfceph-remote-runner.mjs';

const OVERLAP_LINE_TEMPLATES = WEBPAGE_LINE_TEMPLATES.filter((template) => (
  template.name !== 'line_Ruler'
  && !template.name.startsWith('spine_')
  && !template.name.startsWith('airway_')
));

const ALIGNMENT_PRESETS = {
  SN: {
    code: 'SN',
    label: 'SN 对齐',
    anchors: ['S', 'N'],
  },
  FH: {
    code: 'FH',
    label: 'FH 对齐',
    anchors: ['Po', 'Or'],
  },
};

const ANCHOR_ALIASES = {
  N: ['N', 'Na'],
};

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high);
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function normalizeAlignMode(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return ALIGNMENT_PRESETS[normalized] ? normalized : 'SN';
}

function transformPointCloud(points, transform) {
  return points.map((point) => ({
    ...point,
    ...transform.transformPoint(point),
  }));
}

function shiftPointCloud(points, offsetX, offsetY) {
  return points.map((point) => ({
    ...point,
    x: round1(point.x + offsetX),
    y: round1(point.y + offsetY),
  }));
}

function collectHeadPoints(output) {
  const overlayData = collectOverlayData(output?.resultPayload || null);
  return overlayData?.headPoints?.length ? overlayData.headPoints : [];
}

function resolveAnchorPoint(lookup, landmark) {
  const candidates = ANCHOR_ALIASES[landmark] || [landmark];
  for (const candidate of candidates) {
    const point = lookup.get(candidate);
    if (point) {
      return point;
    }
  }
  return null;
}

function requireAnchors(lookup, anchorNames, label) {
  const points = anchorNames.map((landmark) => resolveAnchorPoint(lookup, landmark));
  if (points.some((point) => !point)) {
    const missing = anchorNames.filter((landmark, index) => !points[index]);
    throw new Error(`${label} 缺少重叠对齐点：${missing.join('、')}`);
  }
  return points;
}

function computeBounds(pointGroups) {
  const allPoints = pointGroups.flat().filter(Boolean);
  if (!allPoints.length) {
    return {
      minX: 0,
      minY: 0,
      maxX: 1200,
      maxY: 900,
    };
  }
  return {
    minX: Math.min(...allPoints.map((point) => point.x)),
    minY: Math.min(...allPoints.map((point) => point.y)),
    maxX: Math.max(...allPoints.map((point) => point.x)),
    maxY: Math.max(...allPoints.map((point) => point.y)),
  };
}

function renderContourElements({ pointLookup, stroke, opacity, widthScale = 1, dasharray = '' }) {
  return OVERLAP_LINE_TEMPLATES
    .flatMap((template) => buildTemplateSegments(template, pointLookup).map((points) => ({ template, points })))
    .map(({ template, points }) => {
      const pathData = buildSmoothPath(points, Boolean(template.closePath));
      if (!pathData) {
        return '';
      }
      const dash = dasharray ? ` stroke-dasharray="${dasharray}"` : '';
      const width = round1((template.width || 1.8) * widthScale);
      return `<path d="${pathData}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}"${dash} />`;
    })
    .join('');
}

function renderToothFillElements({
  pointLookup,
  fill,
  fillOpacity,
  stroke,
  strokeOpacity,
  strokeWidthScale = 1,
}) {
  return buildToothFillShapes(pointLookup)
    .map((shape) => {
      const pathData = buildSmoothPath(shape.points, true);
      if (!pathData) {
        return '';
      }
      return `<path d="${pathData}" fill="${fill}" fill-opacity="${round1(Math.max(shape.fillOpacity || 0.2, fillOpacity))}" stroke="${stroke}" stroke-opacity="${round1(Math.max(shape.strokeOpacity || 0.8, strokeOpacity))}" stroke-width="${round1((shape.strokeWidth || 1) * strokeWidthScale)}" stroke-linecap="round" stroke-linejoin="round" />`;
    })
    .join('');
}

function buildMetricMap(output) {
  const metrics = Array.isArray(output?.analysis?.metrics) ? output.analysis.metrics : [];
  return Object.fromEntries(
    metrics
      .filter((metric) => metric?.code && metric?.valueText)
      .map((metric) => [metric.code, metric.valueText]),
  );
}

export function buildOverlapRender({ baseOutput, compareOutput, alignMode = 'SN' }) {
  const resolvedAlignMode = normalizeAlignMode(alignMode);
  const alignPreset = ALIGNMENT_PRESETS[resolvedAlignMode];
  const baseHeadPoints = collectHeadPoints(baseOutput);
  const compareHeadPoints = collectHeadPoints(compareOutput);

  if (!baseHeadPoints.length || !compareHeadPoints.length) {
    throw new Error('重叠失败：至少有一侧未返回有效头影轮廓点。');
  }

  const baseLookup = buildPointLookup(baseHeadPoints);
  const compareLookup = buildPointLookup(compareHeadPoints);
  const baseAnchors = requireAnchors(baseLookup, alignPreset.anchors, '基准图');
  const compareAnchors = requireAnchors(compareLookup, alignPreset.anchors, '对照图');
  const transform = buildSimilarityTransform(compareAnchors, baseAnchors);

  if (!transform) {
    throw new Error(`重叠失败：${alignPreset.label} 的几何变换不可解。`);
  }

  const transformedComparePoints = transformPointCloud(compareHeadPoints, transform);
  const bounds = computeBounds([baseHeadPoints, transformedComparePoints]);
  const padding = 84;
  const width = Math.max(920, Math.ceil(bounds.maxX - bounds.minX + padding * 2));
  const height = Math.max(920, Math.ceil(bounds.maxY - bounds.minY + padding * 2));
  const offsetX = padding - bounds.minX;
  const offsetY = padding - bounds.minY;
  const shiftedBasePoints = shiftPointCloud(baseHeadPoints, offsetX, offsetY);
  const shiftedComparePoints = shiftPointCloud(transformedComparePoints, offsetX, offsetY);
  const shiftedBaseLookup = buildPointLookup(shiftedBasePoints);
  const shiftedCompareLookup = buildPointLookup(shiftedComparePoints);

  const baseStroke = '#f59e0b';
  const compareStroke = '#22d3ee';
  const baseElements = renderContourElements({
    pointLookup: shiftedBaseLookup,
    stroke: baseStroke,
    opacity: 0.92,
    widthScale: 1.02,
  });
  const compareElements = renderContourElements({
    pointLookup: shiftedCompareLookup,
    stroke: compareStroke,
    opacity: 0.9,
    widthScale: 1.02,
  });
  const baseToothFillElements = renderToothFillElements({
    pointLookup: shiftedBaseLookup,
    fill: '#fcd34d',
    fillOpacity: 0.48,
    stroke: baseStroke,
    strokeOpacity: 0.82,
    strokeWidthScale: 1,
  });
  const compareToothFillElements = renderToothFillElements({
    pointLookup: shiftedCompareLookup,
    fill: '#67e8f9',
    fillOpacity: 0.34,
    stroke: compareStroke,
    strokeOpacity: 0.72,
    strokeWidthScale: 1,
  });

  const baseLegendX = width - 232;
  const legendY = 44;
  const lineHeight = 24;
  const legendLines = [
    'HYF Ceph Overlap',
    alignPreset.label,
    `基准: ${baseOutput?.analysis?.riskLabel || '未生成结论'}`,
    `对照: ${compareOutput?.analysis?.riskLabel || '未生成结论'}`,
  ];
  const legendText = legendLines
    .map((line, index) => {
      const y = legendY + 34 + index * lineHeight;
      const fontWeight = index === 0 ? 700 : 500;
      return `<text x="${baseLegendX + 18}" y="${y}" font-family="Menlo, Consolas, monospace" font-size="16" font-weight="${fontWeight}" fill="#e5e7eb">${escapeXml(line)}</text>`;
    })
    .join('');

  const svgText = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="#0b1220" />`,
    `<rect x="${baseLegendX}" y="${legendY}" width="196" height="${lineHeight * legendLines.length + 34}" rx="16" fill="#111827" opacity="0.92" />`,
    `<line x1="${baseLegendX + 20}" y1="${legendY + 16}" x2="${baseLegendX + 64}" y2="${legendY + 16}" stroke="${baseStroke}" stroke-width="3.5" stroke-linecap="round" opacity="0.95" />`,
    `<line x1="${baseLegendX + 96}" y1="${legendY + 16}" x2="${baseLegendX + 140}" y2="${legendY + 16}" stroke="${compareStroke}" stroke-width="3.5" stroke-linecap="round" opacity="0.95" />`,
    `<g>${baseToothFillElements}</g>`,
    `<g>${compareToothFillElements}</g>`,
    `<g>${baseElements}</g>`,
    `<g>${compareElements}</g>`,
    `<g>${legendText}</g>`,
    `</svg>`,
  ].join('');

  return {
    svgText,
    analysis: {
      type: 'overlap',
      alignMode: alignPreset.code,
      alignLabel: alignPreset.label,
      base: {
        riskLabel: baseOutput?.analysis?.riskLabel || null,
        metrics: Array.isArray(baseOutput?.analysis?.metrics) ? baseOutput.analysis.metrics : [],
      },
      compare: {
        riskLabel: compareOutput?.analysis?.riskLabel || null,
        metrics: Array.isArray(compareOutput?.analysis?.metrics) ? compareOutput.analysis.metrics : [],
      },
    },
    summary: {
      mode: 'overlap',
      alignMode: alignPreset.code,
      alignLabel: alignPreset.label,
      baseRiskLabel: baseOutput?.analysis?.riskLabel || null,
      compareRiskLabel: compareOutput?.analysis?.riskLabel || null,
      baseMetricValues: buildMetricMap(baseOutput),
      compareMetricValues: buildMetricMap(compareOutput),
      supportedAlignModes: Object.keys(ALIGNMENT_PRESETS),
      basePointCount: baseHeadPoints.length,
      comparePointCount: compareHeadPoints.length,
      canvas: { width, height },
    },
    metrics: [],
  };
}

export function listSupportedAlignModes() {
  return Object.keys(ALIGNMENT_PRESETS);
}
