import fs from 'node:fs/promises';
import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool';

// The workbook itself is now the source of truth. This script performs a
// non-destructive QA/export pass; it no longer rebuilds the retired hotspot-only schema.
const inputPath = process.argv[2] || 'F:/code/koubo/data/content_ledger.xlsx';
const outputDir = process.argv[3] || 'F:/code/koubo/outputs/ledger-qa';
const requiredSheets = [
  '仪表盘', '内容台账', '候选评分', '每周复盘', '评分规则',
  '成长内容台账', '成长选题评分', '创作者档案', '30天成长路线',
  '双重复盘', '成长评分规则',
];

await fs.mkdir(outputDir, { recursive: true });
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(inputPath));
const sheetInspect = await workbook.inspect({ kind: 'sheet', include: 'id,name', maxChars: 12000 });
const sheetText = sheetInspect.ndjson;
const missing = requiredSheets.filter((name) => !sheetText.includes(`"name":"${name}"`));
if (missing.length) throw new Error(`Workbook is missing required sheets: ${missing.join(', ')}`);

const legacy = await workbook.inspect({
  kind: 'table', range: '内容台账!A1:T5', include: 'values,formulas',
  tableMaxRows: 6, tableMaxCols: 22, maxChars: 12000,
});
if (!legacy.ndjson.includes('旧定位基线')) throw new Error('Legacy Day 1 baseline marker is missing.');

const growth = await workbook.inspect({
  kind: 'table', range: '成长内容台账!A1:AH6', include: 'values,formulas',
  tableMaxRows: 8, tableMaxCols: 40, maxChars: 20000,
});
if (!growth.ndjson.includes('Day 1')) throw new Error('Growth Day 1 sample is missing.');

const errors = await workbook.inspect({
  kind: 'match',
  searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A',
  options: { useRegex: true, maxResults: 300 },
  summary: 'content ledger formula error scan',
  maxChars: 10000,
});
if (!errors.ndjson.includes('matched 0 entries')) throw new Error(`Formula errors found:\n${errors.ndjson}`);

await fs.writeFile(`${outputDir}/sheets.ndjson`, sheetInspect.ndjson, 'utf8');
await fs.writeFile(`${outputDir}/legacy_baseline.ndjson`, legacy.ndjson, 'utf8');
await fs.writeFile(`${outputDir}/growth_ledger.ndjson`, growth.ndjson, 'utf8');
await fs.writeFile(`${outputDir}/formula_errors.ndjson`, errors.ndjson, 'utf8');

for (const [sheetName, range, file] of [
  ['仪表盘', 'A1:H16', 'dashboard.png'],
  ['成长内容台账', 'A1:AH7', 'growth_ledger.png'],
  ['成长选题评分', 'A1:T9', 'growth_score.png'],
  ['创作者档案', 'A1:E8', 'creator.png'],
  ['30天成长路线', 'A1:G34', 'roadmap.png'],
  ['双重复盘', 'A1:U9', 'dual_review.png'],
  ['成长评分规则', 'A1:E20', 'growth_rules.png'],
  ['内容台账', 'A1:T6', 'legacy_ledger.png'],
]) {
  const preview = await workbook.render({ sheetName, range, scale: 1, format: 'png' });
  await fs.writeFile(`${outputDir}/${file}`, new Uint8Array(await preview.arrayBuffer()));
}

const xlsx = await SpreadsheetFile.exportXlsx(workbook);
await xlsx.save(`${outputDir}/content_ledger_qa_copy.xlsx`);
console.log(JSON.stringify({ inputPath, outputDir, requiredSheets: requiredSheets.length, formulaErrors: 0 }, null, 2));
