import fs from 'node:fs/promises';
import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool';

// The workbook is the source of truth. This script performs a non-destructive
// QA/render/export pass for the active developer-content schema.
const inputPath = process.argv[2] || 'F:/code/koubo/data/content_ledger.xlsx';
const outputDir = process.argv[3] || 'F:/code/koubo/outputs/ledger-qa';
const requiredSheets = [
  '仪表盘',
  '内容实验台账',
  '选题实验',
  '资源交付',
  '内容评分规则',
  '创作者档案',
  '历史-内容台账',
  '历史-成长内容台账',
];

await fs.mkdir(outputDir, { recursive: true });
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(inputPath));
const sheetInspect = await workbook.inspect({ kind: 'sheet', include: 'id,name', maxChars: 12000 });
const sheetText = sheetInspect.ndjson;
const missing = requiredSheets.filter((name) => !sheetText.includes(`"name":"${name}"`));
if (missing.length) throw new Error(`Workbook is missing required sheets: ${missing.join(', ')}`);
if (sheetText.includes('"name":"30天成长路线"')) {
  throw new Error('Retired 30-day roadmap is still present as an active worksheet.');
}

const dashboard = await workbook.inspect({
  kind: 'table', range: '仪表盘!A1:H17', include: 'values,formulas',
  tableMaxRows: 20, tableMaxCols: 10, maxChars: 18000,
});
if (!dashboard.ndjson.includes('AI Builder 内容实验仪表盘')) {
  throw new Error('Developer-content dashboard marker is missing.');
}

const experiments = await workbook.inspect({
  kind: 'table', range: '内容实验台账!A1:V10', include: 'values,formulas',
  tableMaxRows: 12, tableMaxCols: 24, maxChars: 24000,
});
for (const marker of ['Skill真实跑通', 'Agent工作流拆解', '开源项目审计', '可复用资产']) {
  if (!experiments.ndjson.includes(marker)) throw new Error(`Experiment ledger marker is missing: ${marker}`);
}

const profile = await workbook.inspect({
  kind: 'table', range: '创作者档案!A1:E10', include: 'values,formulas',
  tableMaxRows: 12, tableMaxCols: 7, maxChars: 16000,
});
if (!profile.ndjson.includes('Windows 本地实测型 AI Builder')) {
  throw new Error('Creator profile positioning marker is missing.');
}

const errors = await workbook.inspect({
  kind: 'match',
  searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A',
  options: { useRegex: true, maxResults: 300 },
  summary: 'content ledger formula error scan',
  maxChars: 10000,
});
if (!errors.ndjson.includes('matched 0 entries')) throw new Error(`Formula errors found:\n${errors.ndjson}`);

await fs.writeFile(`${outputDir}/sheets.ndjson`, sheetInspect.ndjson, 'utf8');
await fs.writeFile(`${outputDir}/dashboard.ndjson`, dashboard.ndjson, 'utf8');
await fs.writeFile(`${outputDir}/experiments.ndjson`, experiments.ndjson, 'utf8');
await fs.writeFile(`${outputDir}/creator.ndjson`, profile.ndjson, 'utf8');
await fs.writeFile(`${outputDir}/formula_errors.ndjson`, errors.ndjson, 'utf8');

for (const [sheetName, range, file] of [
  ['仪表盘', 'A1:H17', 'dashboard.png'],
  ['内容实验台账', 'A1:V10', 'content_experiments.png'],
  ['选题实验', 'A1:N17', 'topic_experiments.png'],
  ['资源交付', 'A1:I7', 'resource_delivery.png'],
  ['内容评分规则', 'A1:E18', 'scoring_rules.png'],
  ['创作者档案', 'A1:E10', 'creator.png'],
  ['历史-内容台账', 'A1:T12', 'historical_ledger.png'],
  ['历史-成长内容台账', 'A1:AH12', 'historical_growth_ledger.png'],
]) {
  const preview = await workbook.render({ sheetName, range, scale: 1, format: 'png' });
  await fs.writeFile(`${outputDir}/${file}`, new Uint8Array(await preview.arrayBuffer()));
}

const xlsx = await SpreadsheetFile.exportXlsx(workbook);
await xlsx.save(`${outputDir}/content_ledger_qa_copy.xlsx`);
console.log(JSON.stringify({ inputPath, outputDir, requiredSheets: requiredSheets.length, formulaErrors: 0 }, null, 2));
