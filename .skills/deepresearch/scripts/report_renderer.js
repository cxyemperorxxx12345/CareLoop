#!/usr/bin/env node
'use strict';

/**
 * Private deterministic DOCX renderer for save_report.py.
 *
 * Contract:
 *   node report_renderer.js --input <render_model.json> --output <report.docx>
 *
 * The renderer performs presentation only.  It does not validate research,
 * change prose, install dependencies, choose output paths, or decide whether a
 * report is ready.  save_report.py owns all of those decisions.
 */

const fs = require('fs');
const path = require('path');


function fail(message) {
  process.stderr.write(`RENDERER_ERROR: ${message}\n`);
  process.exit(1);
}


function loadDocx() {
  const executableDir = path.dirname(process.execPath);
  const explicit = process.env.DOCX_MODULE_PATH;
  const candidates = [
    'docx',
    explicit,
    path.join(__dirname, 'node_modules', 'docx'),
    path.resolve(executableDir, '..', 'node_modules', 'docx'),
    path.resolve(executableDir, '..', 'lib', 'node_modules', 'docx'),
    path.resolve(executableDir, '..', '..', 'node_modules', 'docx'),
  ].filter(Boolean);

  const attempted = [];
  for (const candidate of [...new Set(candidates)]) {
    try {
      return require(candidate);
    } catch (error) {
      if (error && error.code === 'MODULE_NOT_FOUND') {
        attempted.push(candidate);
        continue;
      }
      throw error;
    }
  }
  throw new Error(
    `无法加载 docx 依赖。已尝试：${attempted.join(', ')}。` +
      '请在运行环境中预置 docx，渲染器不会自动安装依赖。',
  );
}


const docx = loadDocx();

const {
  AlignmentType,
  Bookmark,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  HeadingLevel,
  ImageRun,
  InternalHyperlink,
  LevelFormat,
  LineRuleType,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} = docx;

const PAGE_WIDTH = 12240; // Letter, twips
const PAGE_HEIGHT = 15840;
const MARGIN_LEFT = 1260;
const MARGIN_RIGHT = 1260;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
const BODY_FONT_SIZE = 22; // half-points = 11 pt
const FONT_LATIN = 'Aptos';
const FONT_CJK = 'Microsoft YaHei';
const COLOR_TEXT = '222222';
const COLOR_MUTED = '666666';
const COLOR_LINK = '0563C1';
const COLOR_TABLE_HEADER = '1F4E78';
const COLOR_TABLE_ALT = 'EEF4F8';
const COLOR_BORDER = 'D9D9D9';


function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--input' || token === '--output') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        fail(`${token} 缺少路径。`);
      }
      result[token.slice(2)] = value;
      index += 1;
    } else if (token === '--help' || token === '-h') {
      process.stdout.write(
        'Usage: node report_renderer.js --input <render_model.json> --output <report.docx>\n',
      );
      process.exit(0);
    } else {
      fail(`未知参数：${token}`);
    }
  }
  if (!result.input || !result.output) {
    fail('必须同时提供 --input 和 --output。');
  }
  return result;
}


function readModel(inputPath) {
  let raw;
  try {
    raw = fs.readFileSync(inputPath, 'utf8');
  } catch (error) {
    fail(`无法读取渲染模型 ${inputPath}：${error.message}`);
  }

  let model;
  try {
    model = JSON.parse(raw);
  } catch (error) {
    fail(`渲染模型不是有效 JSON：${error.message}`);
  }

  if (!model || model.schema_version !== 1) {
    fail('不支持的渲染模型版本，当前只接受 schema_version=1。');
  }
  if (!model.document || typeof model.document.title !== 'string') {
    fail('渲染模型缺少 document.title。');
  }
  if (!Array.isArray(model.document.blocks)) {
    fail('渲染模型缺少 document.blocks 数组。');
  }
  if (!Array.isArray(model.document.references)) {
    fail('渲染模型缺少 document.references 数组。');
  }
  if (!/^zh(?:-|$)|^en(?:-|$)/i.test(String(model.document.language || ''))) {
    fail('document.language 当前只支持 zh 或 en。');
  }
  if (model.document.toc !== undefined && !Array.isArray(model.document.toc)) {
    fail('document.toc 必须是数组。');
  }

  const allowedTypes = new Set([
    'heading',
    'paragraph',
    'list_item',
    'table',
    'image',
    'code',
    'blockquote',
  ]);
  for (const [index, block] of model.document.blocks.entries()) {
    if (!block || !allowedTypes.has(block.type)) {
      fail(`document.blocks[${index}] 的类型无效：${block && block.type}`);
    }
  }
  return model;
}


function fontSpec() {
  return {
    ascii: FONT_LATIN,
    hAnsi: FONT_LATIN,
    eastAsia: FONT_CJK,
    cs: FONT_LATIN,
  };
}


function cleanText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&nbsp;/gi, ' ');
}


function documentLabels(language) {
  const english = /^en(?:-|$)/i.test(String(language || ''));
  return english
    ? { references: 'References', pagePrefix: 'Page ', pageSuffix: '' }
    : { references: '参考文献', pagePrefix: '第 ', pageSuffix: ' 页' };
}


function normalizeStructuralLabel(value) {
  return cleanText(value)
    .replace(/[*_`]/g, '')
    .replace(/^第[一二三四五六七八九十百零〇0-9]+[章节部分]\s*/, '')
    .replace(/^[（(]?[一二三四五六七八九十百零〇0-9]+[）)]?[、.．:：\s-]+/, '')
    .replace(/[\s：:、，,。.!！?？（）()《》<>【】\[\]-]+/g, '')
    .toLowerCase();
}


function cleanUrl(value) {
  let cleaned = String(value ?? '').replace(/[.,;:!?，。；：！？）\]}"']+$/g, '');
  // Markdown or sentence punctuation can contribute one unmatched closing
  // parenthesis, but balanced parentheses may be part of the URL itself.
  while (
    cleaned.endsWith(')')
    && (cleaned.match(/\)/g) || []).length > (cleaned.match(/\(/g) || []).length
  ) {
    cleaned = cleaned.slice(0, -1);
  }
  return cleaned;
}


function bookmarkId(referenceId) {
  return `ref_${String(referenceId).replace(/[^A-Za-z0-9_]/g, '_')}`;
}


function newRun(text, inherited = {}, extra = {}) {
  return new TextRun({
    text,
    color: COLOR_TEXT,
    size: BODY_FONT_SIZE,
    font: fontSpec(),
    ...inherited,
    ...extra,
  });
}


function externalLink(label, link, inherited = {}) {
  return new ExternalHyperlink({
    link: cleanUrl(link),
    children: [
      new TextRun({
        text: label,
        style: 'Hyperlink',
        size: BODY_FONT_SIZE,
        font: fontSpec(),
        ...inherited,
      }),
    ],
  });
}


function citationLink(referenceId) {
  return new InternalHyperlink({
    anchor: bookmarkId(referenceId),
    children: [
      new TextRun({
        text: `[${referenceId}]`,
        style: 'CitationReference',
        superScript: true,
        size: 18,
        font: fontSpec(),
      }),
    ],
  });
}


/**
 * Parse the small inline Markdown subset emitted by save_report.py.
 * Nested emphasis is supported recursively.  Unknown syntax stays visible as
 * ordinary text rather than being dropped.
 */
function inlineChildren(markdown, inherited = {}) {
  const source = cleanText(markdown);
  const children = [];
  let plain = '';

  const flush = () => {
    if (plain) {
      children.push(newRun(plain, inherited));
      plain = '';
    }
  };

  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);

    if (rest[0] === '\\' && rest.length > 1) {
      plain += rest[1];
      index += 2;
      continue;
    }

    if (rest[0] === '\n') {
      flush();
      children.push(new TextRun({ break: 1, size: BODY_FONT_SIZE, font: fontSpec() }));
      index += 1;
      continue;
    }

    const citation = rest.match(/^\[\^([^\]\s]+)\]/);
    if (citation) {
      flush();
      children.push(citationLink(citation[1]));
      index += citation[0].length;
      continue;
    }

    const image = rest.match(/^!\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["']([^"']*)["'])?\)/);
    if (image) {
      flush();
      const alt = image[1].trim() || '图片';
      children.push(newRun(`【图：${alt}】`, inherited, { italics: true, color: COLOR_MUTED }));
      index += image[0].length;
      continue;
    }

    const link = rest.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/i);
    if (link) {
      flush();
      children.push(externalLink(link[1], link[2], inherited));
      index += link[0].length;
      continue;
    }

    const boldMarker = rest.startsWith('**') ? '**' : rest.startsWith('__') ? '__' : null;
    if (boldMarker) {
      const close = rest.indexOf(boldMarker, 2);
      if (close !== -1) {
        flush();
        children.push(...inlineChildren(rest.slice(2, close), { ...inherited, bold: true }));
        index += close + 2;
        continue;
      }
    }

    if (rest[0] === '`') {
      const close = rest.indexOf('`', 1);
      if (close !== -1) {
        flush();
        children.push(
          new TextRun({
            text: rest.slice(1, close),
            size: 20,
            font: 'Consolas',
            color: '333333',
            shading: { type: ShadingType.CLEAR, fill: 'F2F2F2', color: 'auto' },
            ...inherited,
          }),
        );
        index += close + 1;
        continue;
      }
    }

    if (rest.startsWith('~~')) {
      const close = rest.indexOf('~~', 2);
      if (close !== -1) {
        flush();
        children.push(...inlineChildren(rest.slice(2, close), { ...inherited, strike: true }));
        index += close + 2;
        continue;
      }
    }

    if (rest[0] === '*' || rest[0] === '_') {
      const close = rest.indexOf(rest[0], 1);
      if (close > 1) {
        flush();
        children.push(...inlineChildren(rest.slice(1, close), { ...inherited, italics: true }));
        index += close + 1;
        continue;
      }
    }

    plain += source[index];
    index += 1;
  }
  flush();
  return children.length ? children : [newRun('')];
}


function headingLevel(level) {
  const levels = {
    2: HeadingLevel.HEADING_1,
    3: HeadingLevel.HEADING_2,
    4: HeadingLevel.HEADING_3,
    5: HeadingLevel.HEADING_4,
    6: HeadingLevel.HEADING_5,
  };
  return levels[level] || HeadingLevel.HEADING_1;
}


function isReferenceHeading(markdown) {
  const value = normalizeStructuralLabel(markdown);
  return value.includes('参考文献') || value.includes('参考资料') || value === '来源'
    || ['references', 'bibliography', 'sources'].includes(value);
}


function isTocHeading(markdown) {
  const value = normalizeStructuralLabel(markdown);
  return value === '目录' || value === '内容目录'
    || value === 'contents' || value === 'tableofcontents';
}


function isSummaryLabel(markdown) {
  const value = normalizeStructuralLabel(markdown);
  return [
    '摘要', '内容摘要', '执行摘要', '概览',
    'abstract', 'summary', 'executivesummary', 'overview',
  ].includes(value);
}


function renderParagraph(block) {
  if (isSummaryLabel(block.markdown)) {
    return new Paragraph({
      children: inlineChildren(block.markdown, { bold: true, color: '000000' }),
      alignment: AlignmentType.LEFT,
      spacing: { before: 80, after: 120 },
      keepNext: true,
    });
  }
  return new Paragraph({
    children: inlineChildren(block.markdown),
    alignment: AlignmentType.JUSTIFIED,
    spacing: { after: 160, line: 360, lineRule: LineRuleType.AUTO },
    widowControl: true,
  });
}


function renderHeading(block) {
  const level = Number(block.level) || 2;
  const runs = inlineChildren(block.markdown, { bold: true, color: '000000' });
  const children = block.bookmark
    ? [new Bookmark({ id: String(block.bookmark), children: runs })]
    : runs;
  if (level === 1) {
    return new Paragraph({
      style: 'Title',
      children,
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 420 },
      keepNext: true,
    });
  }
  return new Paragraph({
    heading: headingLevel(level),
    children,
    spacing: {
      before: level === 2 ? 300 : 220,
      after: level === 2 ? 140 : 100,
    },
    keepNext: true,
    keepLines: true,
  });
}


function renderTocEntry(entry) {
  const level = Number(entry.level) === 2 ? 2 : 1;
  const text = cleanText(entry.text).trim();
  const bookmark = String(entry.bookmark || '');
  return new Paragraph({
    style: level === 2 ? 'StaticTOC2' : 'StaticTOC1',
    children: [
      new InternalHyperlink({
        anchor: bookmark,
        children: [
          new TextRun({
            text,
            color: COLOR_TEXT,
            size: level === 2 ? 20 : BODY_FONT_SIZE,
            font: fontSpec(),
          }),
        ],
      }),
    ],
    keepLines: true,
    widowControl: true,
  });
}


function renderListItem(block, orderedInstance) {
  const level = Math.max(0, Math.min(5, Number(block.level) || 0));
  const common = {
    children: inlineChildren(block.markdown),
    spacing: { after: 80, line: 320, lineRule: LineRuleType.AUTO },
    widowControl: true,
  };
  if (block.ordered) {
    return new Paragraph({
      ...common,
      numbering: { reference: 'ordered-list', level, instance: orderedInstance },
    });
  }
  return new Paragraph({ ...common, bullet: { level } });
}


function renderBlockquote(block) {
  return new Paragraph({
    children: inlineChildren(block.markdown, { italics: true, color: COLOR_MUTED }),
    indent: { left: 420, right: 240 },
    spacing: { before: 80, after: 160, line: 340, lineRule: LineRuleType.AUTO },
    alignment: AlignmentType.JUSTIFIED,
  });
}


function renderCode(block) {
  const lines = cleanText(block.text).split('\n');
  const children = [];
  for (const [index, line] of lines.entries()) {
    children.push(
      new TextRun({
        text: line || ' ',
        font: 'Consolas',
        size: 19,
        color: '333333',
        break: index === 0 ? undefined : 1,
      }),
    );
  }
  return new Paragraph({
    children,
    shading: { type: ShadingType.CLEAR, fill: 'F5F5F5', color: 'auto' },
    indent: { left: 240, right: 240 },
    spacing: { before: 100, after: 180, line: 280, lineRule: LineRuleType.AUTO },
    keepLines: true,
  });
}


function textWeight(value) {
  const text = cleanText(value).replace(/\[\^[^\]]+\]/g, '');
  let score = 0;
  for (const char of text) {
    score += /[\u3400-\u9fff]/.test(char) ? 2 : 1;
  }
  return Math.max(4, Math.min(50, score));
}


function calculateColumnWidths(header, rows) {
  const columnCount = header.length;
  const weights = [];
  for (let column = 0; column < columnCount; column += 1) {
    let weight = textWeight(header[column]);
    for (const row of rows.slice(0, 20)) {
      weight = Math.max(weight, textWeight(row[column] || ''));
    }
    weights.push(Math.sqrt(weight));
  }
  const minimum = Math.min(900, Math.floor(CONTENT_WIDTH / columnCount));
  const flexible = Math.max(0, CONTENT_WIDTH - minimum * columnCount);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0) || 1;
  const widths = weights.map((weight) => minimum + Math.floor((flexible * weight) / totalWeight));
  widths[widths.length - 1] += CONTENT_WIDTH - widths.reduce((sum, value) => sum + value, 0);
  return widths;
}


function tableBorders() {
  const border = { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER };
  return {
    top: border,
    bottom: border,
    left: border,
    right: border,
    insideHorizontal: border,
    insideVertical: border,
  };
}


function isCompactCell(value) {
  const text = cleanText(value).replace(/[*_`]/g, '').trim();
  return text.length <= 18 && !/[。；;!?！？]/.test(text);
}


function tableCell(value, width, options = {}) {
  const { header = false, alternate = false } = options;
  const alignment = header || isCompactCell(value) ? AlignmentType.CENTER : AlignmentType.LEFT;
  const runs = inlineChildren(value, {
    bold: header,
    color: header ? 'FFFFFF' : COLOR_TEXT,
  });
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    verticalAlign: VerticalAlign.CENTER,
    margins: {
      marginUnitType: WidthType.DXA,
      top: 110,
      bottom: 110,
      left: 130,
      right: 130,
    },
    shading: {
      type: ShadingType.CLEAR,
      fill: header ? COLOR_TABLE_HEADER : alternate ? COLOR_TABLE_ALT : 'FFFFFF',
      color: 'auto',
    },
    children: [
      new Paragraph({
        children: runs,
        alignment,
        spacing: { before: 0, after: 0, line: 280, lineRule: LineRuleType.AUTO },
      }),
    ],
  });
}


function renderTable(block) {
  const header = Array.isArray(block.header) ? block.header.map(cleanText) : [];
  const rows = Array.isArray(block.rows) ? block.rows.map((row) => row.map(cleanText)) : [];
  if (!header.length) {
    throw new Error('表格缺少表头。');
  }
  if (rows.some((row) => row.length !== header.length)) {
    throw new Error('表格数据列数与表头不一致。');
  }
  const widths = calculateColumnWidths(header, rows);
  const tableRows = [
    new TableRow({
      tableHeader: true,
      cantSplit: true,
      children: header.map((value, index) => tableCell(value, widths[index], { header: true })),
    }),
  ];
  for (const [rowIndex, row] of rows.entries()) {
    tableRows.push(
      new TableRow({
        cantSplit: false,
        children: row.map((value, index) =>
          tableCell(value, widths[index], { alternate: rowIndex % 2 === 1 }),
        ),
      }),
    );
  }
  return new Table({
    rows: tableRows,
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    borders: tableBorders(),
    alignment: AlignmentType.CENTER,
  });
}


function imageType(filePath, data) {
  const extension = path.extname(filePath).toLowerCase().replace('.', '');
  if (extension === 'jpeg') {
    return 'jpg';
  }
  if (['jpg', 'png', 'gif', 'bmp'].includes(extension)) {
    return extension;
  }
  if (data.length >= 8 && data.slice(1, 4).toString('ascii') === 'PNG') {
    return 'png';
  }
  if (data.length >= 3 && data.slice(0, 3).toString('ascii') === 'GIF') {
    return 'gif';
  }
  if (data.length >= 2 && data.slice(0, 2).toString('ascii') === 'BM') {
    return 'bmp';
  }
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xd8) {
    return 'jpg';
  }
  throw new Error(`不支持的图片格式：${filePath}`);
}


function jpegDimensions(data) {
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = data[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = data.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > data.length) {
      break;
    }
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
    }
    offset += 2 + length;
  }
  return null;
}


function imageDimensions(type, data) {
  if (type === 'png' && data.length >= 24) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (type === 'gif' && data.length >= 10) {
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  if (type === 'bmp' && data.length >= 26) {
    return { width: Math.abs(data.readInt32LE(18)), height: Math.abs(data.readInt32LE(22)) };
  }
  if (type === 'jpg') {
    return jpegDimensions(data);
  }
  return null;
}


function renderImage(block) {
  const filePath = path.resolve(String(block.path || ''));
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`图片不存在：${filePath}`);
  }
  const data = fs.readFileSync(filePath);
  if (data.length > 50 * 1024 * 1024) {
    throw new Error(`图片超过 50 MiB：${filePath}`);
  }
  const type = imageType(filePath, data);
  const dimensions = imageDimensions(type, data);
  if (!dimensions || !dimensions.width || !dimensions.height) {
    throw new Error(`无法读取图片尺寸：${filePath}`);
  }
  const scale = Math.min(1, 600 / dimensions.width, 620 / dimensions.height);
  const width = Math.max(1, Math.round(dimensions.width * scale));
  const height = Math.max(1, Math.round(dimensions.height * scale));
  const alt = cleanText(block.alt).trim() || '报告图片';
  const image = new ImageRun({
    type,
    data,
    transformation: { width, height },
    altText: { name: alt, title: alt, description: alt },
  });
  const figure = new Paragraph({
    children: [image],
    alignment: AlignmentType.CENTER,
    spacing: { before: 140, after: 60 },
    keepNext: true,
  });
  const captionText = cleanText(block.title).trim() || alt;
  const caption = new Paragraph({
    children: [newRun(captionText, { italics: true, color: COLOR_MUTED }, { size: 19 })],
    alignment: AlignmentType.CENTER,
    spacing: { after: 180 },
    keepLines: true,
  });
  return [figure, caption];
}


function referenceRuns(reference) {
  const value = cleanText(reference.text);
  const urls = Array.isArray(reference.urls) ? reference.urls.map(cleanUrl) : [];
  const children = [
    new Bookmark({
      id: bookmarkId(reference.id),
      children: [newRun(`[${reference.id}] `, { bold: true })],
    }),
  ];
  if (!urls.length) {
    children.push(newRun(value));
    return children;
  }

  let position = 0;
  for (const url of urls) {
    const rawIndex = value.indexOf(url, position);
    const index = rawIndex === -1 ? position : rawIndex;
    if (index > position) {
      children.push(newRun(value.slice(position, index)));
    }
    children.push(externalLink(url, url));
    position = rawIndex === -1 ? position : index + url.length;
  }
  if (position < value.length) {
    children.push(newRun(value.slice(position)));
  }
  return children;
}


function renderReferences(references) {
  return references.map(
    (reference) =>
      new Paragraph({
        children: referenceRuns(reference),
        indent: { hanging: 420, left: 420 },
        spacing: { after: 100, line: 300, lineRule: LineRuleType.AUTO },
        widowControl: true,
      }),
  );
}


function numberingConfig() {
  return {
    config: [
      {
        reference: 'ordered-list',
        levels: Array.from({ length: 6 }, (_, level) => ({
          level,
          format: LevelFormat.DECIMAL,
          text: `%${level + 1}.`,
          alignment: AlignmentType.LEFT,
          style: {
            paragraph: {
              indent: { left: 720 + level * 360, hanging: 360 },
            },
          },
        })),
      },
    ],
  };
}


function documentStyles() {
  return {
    default: {
      document: {
        run: { font: fontSpec(), size: BODY_FONT_SIZE, color: COLOR_TEXT },
        paragraph: {
          spacing: { after: 160, line: 360, lineRule: LineRuleType.AUTO },
        },
      },
    },
    paragraphStyles: [
      {
        id: 'Title',
        name: 'Title',
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: { font: fontSpec(), size: 38, bold: true, color: '000000' },
        paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 0, after: 420 } },
      },
      {
        id: 'Heading1',
        name: 'Heading 1',
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: { font: fontSpec(), size: 30, bold: true, color: '000000' },
        paragraph: { spacing: { before: 300, after: 140 }, outlineLevel: 0 },
      },
      {
        id: 'Heading2',
        name: 'Heading 2',
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: { font: fontSpec(), size: 26, bold: true, color: '000000' },
        paragraph: { spacing: { before: 240, after: 110 }, outlineLevel: 1 },
      },
      {
        id: 'Heading3',
        name: 'Heading 3',
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: { font: fontSpec(), size: 23, bold: true, color: '000000' },
        paragraph: { spacing: { before: 200, after: 90 }, outlineLevel: 2 },
      },
      {
        id: 'StaticTOC1',
        name: 'Static TOC 1',
        basedOn: 'Normal',
        next: 'StaticTOC1',
        run: { font: fontSpec(), size: BODY_FONT_SIZE, color: COLOR_TEXT },
        paragraph: {
          indent: { left: 240, hanging: 0 },
          spacing: { before: 0, after: 70, line: 300, lineRule: LineRuleType.AUTO },
        },
      },
      {
        id: 'StaticTOC2',
        name: 'Static TOC 2',
        basedOn: 'Normal',
        next: 'StaticTOC2',
        run: { font: fontSpec(), size: 20, color: COLOR_TEXT },
        paragraph: {
          indent: { left: 600, hanging: 0 },
          spacing: { before: 0, after: 45, line: 280, lineRule: LineRuleType.AUTO },
        },
      },
    ],
    characterStyles: [
      {
        id: 'Hyperlink',
        name: 'Hyperlink',
        basedOn: 'DefaultParagraphFont',
        run: { color: COLOR_LINK, underline: { type: 'single' } },
      },
      {
        id: 'CitationReference',
        name: 'Citation Reference',
        basedOn: 'DefaultParagraphFont',
        run: { color: COLOR_LINK },
      },
    ],
  };
}


function footer(language) {
  const labels = documentLabels(language);
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({
            children: [labels.pagePrefix, PageNumber.CURRENT, labels.pageSuffix],
            font: fontSpec(),
            size: 18,
            color: COLOR_MUTED,
          }),
        ],
      }),
    ],
  });
}


function buildChildren(model) {
  const children = [];
  const references = model.document.references;
  const labels = documentLabels(model.document.language);
  let referencesRendered = false;
  let orderedInstance = 0;
  let previousOrdered = false;

  for (const block of model.document.blocks) {
    if (block.type === 'heading') {
      children.push(renderHeading(block));
      if (isTocHeading(block.markdown)) {
        children.push(...(model.document.toc || []).map(renderTocEntry));
      }
      if (isReferenceHeading(block.markdown)) {
        children.push(...renderReferences(references));
        referencesRendered = true;
      }
      previousOrdered = false;
    } else if (block.type === 'paragraph') {
      const value = cleanText(block.markdown).trim();
      if (value && !/^(-{3,}|\*{3,}|_{3,})$/.test(value)) {
        children.push(renderParagraph(block));
      }
      previousOrdered = false;
    } else if (block.type === 'list_item') {
      if (block.ordered && !previousOrdered) {
        orderedInstance += 1;
      }
      children.push(renderListItem(block, orderedInstance));
      previousOrdered = Boolean(block.ordered);
    } else if (block.type === 'blockquote') {
      children.push(renderBlockquote(block));
      previousOrdered = false;
    } else if (block.type === 'code') {
      children.push(renderCode(block));
      previousOrdered = false;
    } else if (block.type === 'table') {
      children.push(renderTable(block));
      children.push(new Paragraph({ spacing: { after: 120 } }));
      previousOrdered = false;
    } else if (block.type === 'image') {
      children.push(...renderImage(block));
      previousOrdered = false;
    }
  }

  if (!referencesRendered && references.length) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [newRun(labels.references, { bold: true })],
        keepNext: true,
      }),
    );
    children.push(...renderReferences(references));
  }
  return children;
}


async function render(model, outputPath) {
  const children = buildChildren(model);
  if (!children.length) {
    throw new Error('渲染模型没有可输出的内容。');
  }

  const document = new Document({
    creator: 'Deep Research',
    title: model.document.title,
    description: 'Deep research report',
    styles: documentStyles(),
    numbering: numberingConfig(),
    sections: [
      {
        properties: {
          page: {
            size: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
            margin: {
              top: 1080,
              right: MARGIN_RIGHT,
              bottom: 1080,
              left: MARGIN_LEFT,
              header: 540,
              footer: 540,
              gutter: 0,
            },
          },
        },
        footers: { default: footer(model.document.language) },
        children,
      },
    ],
  });

  const buffer = await Packer.toBuffer(document);
  const resolvedOutput = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  fs.writeFileSync(resolvedOutput, buffer);
  if (!fs.existsSync(resolvedOutput) || fs.statSync(resolvedOutput).size === 0) {
    throw new Error('Packer 未生成非空 DOCX。');
  }
  process.stdout.write(
    JSON.stringify({ status: 'RENDERED', output: resolvedOutput, bytes: buffer.length }) + '\n',
  );
}


async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (path.extname(args.output).toLowerCase() !== '.docx') {
    fail('--output 必须以 .docx 结尾。');
  }
  const model = readModel(path.resolve(args.input));
  await render(model, args.output);
}


main().catch((error) => {
  fail(error && error.stack ? error.stack : String(error));
});
