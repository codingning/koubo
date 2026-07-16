import fs from 'node:fs/promises';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const outputDir = 'F:/code/koubo/outputs/019f6506-51d0-7d53-92ad-12ce4c8d4b35';
const projectCopy = 'F:/code/koubo/data/content_ledger.xlsx';
await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir('F:/code/koubo/data', { recursive: true });

const wb = Workbook.create();
const dashboard = wb.worksheets.add('仪表盘');
const ledger = wb.worksheets.add('内容台账');
const candidates = wb.worksheets.add('候选评分');
const weekly = wb.worksheets.add('每周复盘');
const scoring = wb.worksheets.add('评分规则');

const colors = {
  navy: '#17324D', blue: '#2F6B9A', teal: '#1F7A78', lightBlue: '#EAF3F8',
  yellow: '#FFF3CD', green: '#DFF3E4', red: '#FBE2E2', gray: '#F3F5F7',
  dark: '#243746', white: '#FFFFFF', line: '#D8E0E7', orange: '#F4A261'
};

function titleBand(sheet, range, text) {
  sheet.mergeCells(range);
  const r = sheet.getRange(range);
  r.values = [[text]];
  r.format = {
    fill: colors.navy,
    font: { bold: true, color: colors.white, size: 18 },
    horizontalAlignment: 'left',
    verticalAlignment: 'center',
  };
  r.format.rowHeight = 34;
}

function headerStyle(range) {
  range.format = {
    fill: colors.blue,
    font: { bold: true, color: colors.white },
    horizontalAlignment: 'center',
    verticalAlignment: 'center',
    wrapText: true,
    borders: { preset: 'outside', style: 'thin', color: colors.line },
  };
  range.format.rowHeight = 34;
}

function bodyBorders(range) {
  range.format.borders = {
    insideHorizontal: { style: 'thin', color: colors.line },
    bottom: { style: 'thin', color: colors.line },
  };
  range.format.verticalAlignment = 'center';
}

// Dashboard
 dashboard.showGridLines = false;
 titleBand(dashboard, 'A1:H1', '中文口播账号｜30天内容实验仪表盘');
 dashboard.getRange('A2:H2').merge();
 dashboard.getRange('A2').values = [['数据口径：发布后建议在2小时、24小时、72小时更新；同类型至少3条再下结论。当前为第1天，主选题待人工审核。']];
 dashboard.getRange('A2:H2').format = { fill: colors.lightBlue, font: { color: colors.dark, italic: true }, wrapText: true };
 dashboard.getRange('A2:H2').format.rowHeight = 36;

const cards = [
  ['A3:B3','A4:B5','已发布','=COUNTIF(\'内容台账\'!$S$5:$S$34,"已发布")',colors.green,'0'],
  ['C3:D3','C4:D5','待审核','=COUNTIF(\'内容台账\'!$S$5:$S$34,"待审核")',colors.yellow,'0'],
  ['E3:F3','E4:F5','累计播放','=SUM(\'内容台账\'!$J$5:$J$34)',colors.lightBlue,'0'],
  ['G3:H3','G4:H5','累计涨粉','=SUM(\'内容台账\'!$R$5:$R$34)',colors.lightBlue,'0'],
];
for (const [labelRange,valueRange,label,formula,fill,numFmt] of cards) {
  dashboard.mergeCells(labelRange); dashboard.mergeCells(valueRange);
  dashboard.getRange(labelRange).values = [[label]];
  dashboard.getRange(labelRange).format = { fill: colors.navy, font: { bold: true, color: colors.white }, horizontalAlignment: 'center', verticalAlignment: 'center' };
  dashboard.getRange(valueRange.split(':')[0]).formulas = [[formula]];
  dashboard.getRange(valueRange).format = { fill, font: { bold: true, color: colors.navy, size: 22 }, horizontalAlignment: 'center', verticalAlignment: 'center', numberFormat: numFmt, borders: { preset: 'outside', style: 'thin', color: colors.line } };
}

const metricCards = [
  ['A7:B7','A8:B9','平均3秒留存','=IFERROR(AVERAGEIF(\'内容台账\'!$S$5:$S$34,"已发布",\'内容台账\'!$K$5:$K$34),0)','0.0%'],
  ['C7:D7','C8:D9','平均完播率','=IFERROR(AVERAGEIF(\'内容台账\'!$S$5:$S$34,"已发布",\'内容台账\'!$M$5:$M$34),0)','0.0%'],
  ['E7:F7','E8:F9','平均观看秒','=IFERROR(AVERAGEIF(\'内容台账\'!$S$5:$S$34,"已发布",\'内容台账\'!$L$5:$L$34),0)','0.0'],
  ['G7:H7','G8:H9','综合互动率','=IFERROR((SUM(\'内容台账\'!$N$5:$N$34)+SUM(\'内容台账\'!$O$5:$O$34)+SUM(\'内容台账\'!$P$5:$P$34)+SUM(\'内容台账\'!$Q$5:$Q$34))/SUM(\'内容台账\'!$J$5:$J$34),0)','0.0%'],
];
for (const [labelRange,valueRange,label,formula,numFmt] of metricCards) {
  dashboard.mergeCells(labelRange); dashboard.mergeCells(valueRange);
  dashboard.getRange(labelRange).values = [[label]];
  dashboard.getRange(labelRange).format = { fill: colors.teal, font: { bold: true, color: colors.white }, horizontalAlignment: 'center', verticalAlignment: 'center' };
  dashboard.getRange(valueRange.split(':')[0]).formulas = [[formula]];
  dashboard.getRange(valueRange).format = { fill: '#EEF8F7', font: { bold: true, color: colors.teal, size: 20 }, horizontalAlignment: 'center', verticalAlignment: 'center', numberFormat: numFmt, borders: { preset: 'outside', style: 'thin', color: colors.line } };
}

dashboard.getRange('A11:H11').merge();
dashboard.getRange('A11').values = [['当前实验状态']];
dashboard.getRange('A11:H11').format = { fill: colors.blue, font: { bold: true, color: colors.white } };
dashboard.getRange('A12:B16').values = [
  ['阶段','第1天 / 30天'],
  ['主选题','新能源车“平均车龄1.8年”误读'],
  ['审核状态','等待用户审核口播稿'],
  ['自动化状态','暂不定时；完成3天试运行后再配置'],
  ['下一步','试读、确认标题封面、决定是否拍摄'],
];
dashboard.getRange('A12:A16').format = { fill: colors.gray, font: { bold: true, color: colors.dark } };
dashboard.getRange('B12:H16').merge(true);
dashboard.getRange('B12:H16').format = { wrapText: true };
bodyBorders(dashboard.getRange('A12:H16'));
dashboard.getRange('A1:H16').format.font = { name: 'Microsoft YaHei' };
dashboard.getRange('A1:H16').format.verticalAlignment = 'center';
dashboard.getRange('A1:H16').format.wrapText = true;
dashboard.getRange('A1:H16').format.columnWidth = 16;
dashboard.getRange('A12:A16').format.columnWidth = 14;
dashboard.freezePanes.freezeRows(2);

// Ledger
ledger.showGridLines = false;
titleBand(ledger, 'A1:T1', '30天内容台账');
ledger.mergeCells('A2:T2');
ledger.getRange('A2').values = [['黄色列为人工输入或发布后回填；留存率、完播率请使用百分比。状态：待选题 / 待审核 / 已拍摄 / 已发布 / 已复盘 / 放弃。']];
ledger.getRange('A2:T2').format = { fill: colors.yellow, font: { color: colors.dark }, wrapText: true };
ledger.getRange('A2:T2').format.rowHeight = 32;
const ledgerHeaders = ['发布日期','选题','热点类型','来源平台','标题','封面文案','视频时长(秒)','开头钩子','内容结构','播放量','3秒留存','平均观看时长(秒)','完播率','点赞','评论','收藏','转发','涨粉','状态','备注'];
ledger.getRange('A4:T4').values = [ledgerHeaders];
headerStyle(ledger.getRange('A4:T4'));
const ledgerRows = Array.from({length:30}, () => Array(20).fill(null));
ledgerRows[0] = [
  new Date('2026-07-15T00:00:00+08:00'),
  '新能源车“平均车龄1.8年”误读',
  '消费/科技/数据素养',
  '抖音/小红书/媒体',
  '平均车龄不是汽车寿命，这次很多人看反了',
  '1.8年≠车寿命',
  75,
  '一辆新能源车，平均只开1.8年？不是。',
  '冲突钩子→背景→概念澄清→生活比喻→克制判断→互动问题',
  null,null,null,null,null,null,null,null,null,
  '待审核',
  '主选题与口播稿待用户审核；不得自动发布。'
];
ledger.getRange('A5:T34').values = ledgerRows;
ledger.getRange('A5:A34').format.numberFormat = 'yyyy-mm-dd';
ledger.getRange('G5:G34').format.numberFormat = '0';
ledger.getRange('J5:J34').format.numberFormat = '#,##0';
ledger.getRange('K5:K34').format.numberFormat = '0.0%';
ledger.getRange('L5:L34').format.numberFormat = '0.0';
ledger.getRange('M5:M34').format.numberFormat = '0.0%';
ledger.getRange('N5:R34').format.numberFormat = '#,##0';
ledger.getRange('A5:T34').format.wrapText = true;
bodyBorders(ledger.getRange('A5:T34'));
ledger.getRange('J5:R34').format.fill = '#FFFDF2';
ledger.getRange('S5:S34').dataValidation = { rule: { type: 'list', values: ['待选题','待审核','已拍摄','已发布','已复盘','放弃'] } };
ledger.getRange('C5:C34').dataValidation = { rule: { type: 'list', values: ['社会热点','AI/科技','消费/生活','职场','互联网','国际趣闻','娱乐','体育','政策/公共议题'] } };
ledger.getRange('S5:S34').conditionalFormats.add('containsText', { text: '待审核', format: { fill: colors.yellow, font: { color: '#7A5900', bold: true } } });
ledger.getRange('S5:S34').conditionalFormats.add('containsText', { text: '已发布', format: { fill: colors.green, font: { color: '#176B36', bold: true } } });
ledger.tables.add('A4:T34', true, 'ContentLedgerTable').style = 'TableStyleMedium2';
ledger.freezePanes.freezeRows(4);
const ledgerWidths = [12,28,18,18,34,18,12,34,40,12,12,16,12,10,10,10,10,10,12,34];
ledgerWidths.forEach((w,i)=>ledger.getRangeByIndexes(0,i,34,1).format.columnWidth=w);
ledger.getRange('A1:T34').format.font = { name: 'Microsoft YaHei', size: 10 };
ledger.getRange('A5:T34').format.rowHeight = 38;
ledger.getRange('A5:T5').format.rowHeight = 62;

// Candidates
candidates.showGridLines = false;
titleBand(candidates, 'A1:Q1', '每日候选选题评分｜2026-07-15');
candidates.mergeCells('A2:Q2');
candidates.getRange('A2').values = [['风险分越高风险越大。推荐指数 = 正向加权分 - max(0, 风险-3)×2.5；主选题可信度和可讲性均需≥8。']];
candidates.getRange('A2:Q2').format = { fill: colors.lightBlue, wrapText: true, font: { color: colors.dark } };
const candHeaders = ['日期','候选','类型','时效','相关','新奇','可讲','观点','互动','可信','风险','正向加权分','风险扣分','推荐指数','结论','推荐/不推荐原因','主要来源'];
candidates.getRange('A4:Q4').values = [candHeaders];
headerStyle(candidates.getRange('A4:Q4'));
const candRows = [
 [new Date('2026-07-15T00:00:00+08:00'),'新能源车“平均车龄1.8年”误读','消费/科技/数据素养',9,9,9,10,9,9,9,3,null,null,null,'主选题','跨抖音和小红书；口径反常识、可核验、风险低','https://www.eeo.com.cn/2026/0714/817225.shtml'],
 [new Date('2026-07-15T00:00:00+08:00'),'AI拟人化互动服务新规施行','AI/社会/政策',10,9,9,9,10,10,10,6,null,null,null,'备选1','时效与互动强，但法规措辞需人工审核','https://www.cac.gov.cn/2026-04/10/c_1777558395078289.htm'],
 [new Date('2026-07-15T00:00:00+08:00'),'法国队出局但姆巴佩冲击金靴','国际/体育',10,8,7,9,8,9,9,4,null,null,null,'备选2','国际热度高，但赛事状态会持续变化','https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026'],
 [new Date('2026-07-15T00:00:00+08:00'),'人形机器人骑马射箭','科技趣闻',8,8,10,9,8,8,7,3,null,null,null,'不主推','视觉新奇但技术细节和自主程度不足','https://www.douyin.com/hot/2572482/'],
 [new Date('2026-07-15T00:00:00+08:00'),'未成年人申领网号网证','互联网/政策',9,8,7,8,8,9,10,6,null,null,null,'不主推','公共价值高，但政策隐私议题风险较高','https://www.gov.cn/zhengce/content/202505/content_7022047.htm'],
];
candidates.getRange('A5:Q9').values = candRows;
candidates.getRange('L5').formulas = [['=(D5*15+E5*15+F5*12+G5*15+H5*13+I5*12+J5*18)/10']];
candidates.getRange('L5:L9').fillDown();
candidates.getRange('M5').formulas = [['=MAX(0,K5-3)*2.5']];
candidates.getRange('M5:M9').fillDown();
candidates.getRange('N5').formulas = [['=L5-M5']];
candidates.getRange('N5:N9').fillDown();
candidates.getRange('A5:A9').format.numberFormat = 'yyyy-mm-dd';
candidates.getRange('D5:K9').format.numberFormat = '0';
candidates.getRange('L5:N9').format.numberFormat = '0.0';
candidates.getRange('A5:Q9').format.wrapText = true;
bodyBorders(candidates.getRange('A5:Q9'));
candidates.getRange('K5:K9').conditionalFormats.add('cellIs', { operator: 'greaterThanOrEqual', formula: 6, format: { fill: colors.red, font: { color: '#9B1C1C', bold: true } } });
candidates.getRange('N5:N9').conditionalFormats.add('colorScale', { colors: ['#FBE2E2','#FFF3CD','#DFF3E4'], thresholds: ['min','50%','max'] });
candidates.tables.add('A4:Q9', true, 'CandidateScoreTable').style = 'TableStyleMedium4';
candidates.freezePanes.freezeRows(4);
const candWidths=[12,30,20,8,8,8,8,8,8,8,8,14,12,12,12,34,48];
candWidths.forEach((w,i)=>candidates.getRangeByIndexes(0,i,9,1).format.columnWidth=w);
candidates.getRange('A1:Q9').format.font = { name: 'Microsoft YaHei', size: 10 };
candidates.getRange('A5:Q9').format.rowHeight = 54;

// Weekly review
weekly.showGridLines = false;
titleBand(weekly, 'A1:N1', '每7天内容复盘');
weekly.mergeCells('A2:N2');
weekly.getRange('A2').values = [['不要因单条视频下结论；优先比较同类型3条以上。黄色列为人工复盘结论。']];
weekly.getRange('A2:N2').format = { fill: colors.yellow, wrapText: true };
const weekHeaders=['周次','开始日期','结束日期','发布数','平均3秒留存','平均完播率','总播放','互动率','最佳类型','最佳钩子','增加','减少','停止','表达/风险备注'];
weekly.getRange('A4:N4').values=[weekHeaders];
headerStyle(weekly.getRange('A4:N4'));
const starts=['2026-07-15','2026-07-22','2026-07-29','2026-08-05','2026-08-12'];
const weekRows=starts.map((s,i)=>[i+1,new Date(`${s}T00:00:00+08:00`),new Date(new Date(`${s}T00:00:00+08:00`).getTime()+6*86400000),null,null,null,null,null,'','','','','','']);
weekly.getRange('A5:N9').values=weekRows;
for(let r=5;r<=9;r++){
  weekly.getRange(`D${r}`).formulas=[[`=COUNTIFS('内容台账'!$A$5:$A$34,">="&B${r},'内容台账'!$A$5:$A$34,"<="&C${r},'内容台账'!$S$5:$S$34,"已发布")`]];
  weekly.getRange(`E${r}`).formulas=[[`=IFERROR(AVERAGEIFS('内容台账'!$K$5:$K$34,'内容台账'!$A$5:$A$34,">="&B${r},'内容台账'!$A$5:$A$34,"<="&C${r},'内容台账'!$S$5:$S$34,"已发布"),0)`]];
  weekly.getRange(`F${r}`).formulas=[[`=IFERROR(AVERAGEIFS('内容台账'!$M$5:$M$34,'内容台账'!$A$5:$A$34,">="&B${r},'内容台账'!$A$5:$A$34,"<="&C${r},'内容台账'!$S$5:$S$34,"已发布"),0)`]];
  weekly.getRange(`G${r}`).formulas=[[`=SUMIFS('内容台账'!$J$5:$J$34,'内容台账'!$A$5:$A$34,">="&B${r},'内容台账'!$A$5:$A$34,"<="&C${r})`]];
  weekly.getRange(`H${r}`).formulas=[[`=IFERROR((SUMIFS('内容台账'!$N$5:$N$34,'内容台账'!$A$5:$A$34,">="&B${r},'内容台账'!$A$5:$A$34,"<="&C${r})+SUMIFS('内容台账'!$O$5:$O$34,'内容台账'!$A$5:$A$34,">="&B${r},'内容台账'!$A$5:$A$34,"<="&C${r})+SUMIFS('内容台账'!$P$5:$P$34,'内容台账'!$A$5:$A$34,">="&B${r},'内容台账'!$A$5:$A$34,"<="&C${r})+SUMIFS('内容台账'!$Q$5:$Q$34,'内容台账'!$A$5:$A$34,">="&B${r},'内容台账'!$A$5:$A$34,"<="&C${r}))/G${r},0)`]];
}
weekly.getRange('B5:C9').format.numberFormat='yyyy-mm-dd';
weekly.getRange('E5:F9').format.numberFormat='0.0%';
weekly.getRange('G5:G9').format.numberFormat='#,##0';
weekly.getRange('H5:H9').format.numberFormat='0.0%';
weekly.getRange('I5:N9').format.fill='#FFFDF2';
weekly.getRange('A5:N9').format.wrapText=true;
bodyBorders(weekly.getRange('A5:N9'));
weekly.tables.add('A4:N9',true,'WeeklyReviewTable').style='TableStyleMedium2';
weekly.freezePanes.freezeRows(4);
const weekWidths=[8,12,12,10,14,14,12,12,18,32,24,24,24,34];
weekWidths.forEach((w,i)=>weekly.getRangeByIndexes(0,i,9,1).format.columnWidth=w);
weekly.getRange('A1:N9').format.font={name:'Microsoft YaHei',size:10};
weekly.getRange('A5:N9').format.rowHeight=48;

// Scoring rules
scoring.showGridLines=false;
titleBand(scoring,'A1:E1','选题评分规则与风险门槛');
scoring.getRange('A3:E3').values=[['维度','权重','1—3分','4—7分','8—10分']];
headerStyle(scoring.getRange('A3:E3'));
const rules=[
 ['时效性',15,'超过48小时或无新进展','48小时内但热度一般','24小时内且仍在上升'],
 ['目标观众相关性',15,'仅少数圈层关注','部分用户有关','直接影响钱、工作、生活或未来'],
 ['新奇/反常识',12,'普通复述','有一个新信息','结论或口径明显反常识'],
 ['口播可讲性',15,'背景复杂难讲','可在90秒内讲清','一句钩子即可立住冲突'],
 ['观点延展空间',13,'只能复述','能给解释','能给原创判断和生活关联'],
 ['评论互动潜力',12,'观众无话可说','有分歧但问题泛','观众能基于经验回答'],
 ['信息可信度',18,'单一匿名源','可靠媒体但缺一手','官方/一手 + 独立交叉核验'],
 ['内容风险（不计正向权重）',0,'1—3低风险','4—5中风险','6—10较高/高风险'],
];
scoring.getRange('A4:E11').values=rules;
scoring.getRange('A4:E11').format.wrapText=true;
bodyBorders(scoring.getRange('A4:E11'));
scoring.getRange('A4:A11').format={fill:colors.gray,font:{bold:true,color:colors.dark}};
scoring.getRange('B4:B11').format.numberFormat='0';
scoring.getRange('A13:E13').merge();
scoring.getRange('A13').values=[['公式：正向加权分 = Σ(维度分×权重)÷10；风险扣分 = max(0,风险-3)×2.5；推荐指数 = 正向加权分-风险扣分。']];
scoring.getRange('A13:E13').format={fill:colors.yellow,font:{bold:true,color:colors.dark},wrapText:true};
scoring.getRange('A15:E18').values=[
 ['硬门槛','规则','','',''],
 ['主选题','可信度≥8、可讲性≥8、关键事实至少2个来源','','',''],
 ['风险6—7','通常只做备选，必须人工审核','','',''],
 ['风险8—10','默认不做，除非有强公共价值和充分一手证据','','',''],
];
scoring.getRange('A15:E15').format={fill:colors.teal,font:{bold:true,color:colors.white}};
scoring.getRange('A16:A18').format={fill:colors.gray,font:{bold:true}};
scoring.getRange('B16:E18').merge(true);
bodyBorders(scoring.getRange('A15:E18'));
scoring.freezePanes.freezeRows(3);
[20,10,30,34,34].forEach((w,i)=>scoring.getRangeByIndexes(0,i,18,1).format.columnWidth=w);
scoring.getRange('A1:E18').format.font={name:'Microsoft YaHei',size:10};
scoring.getRange('A4:E11').format.rowHeight=42;
scoring.getRange('A13:E13').format.rowHeight=42;

// Compact verification and render all sheets
const inspectDashboard = await wb.inspect({kind:'table',range:'仪表盘!A1:H16',include:'values,formulas',tableMaxRows:20,tableMaxCols:10,maxChars:8000});
await fs.writeFile(`${outputDir}/inspect_dashboard.ndjson`, inspectDashboard.ndjson, 'utf8');
const inspectCandidates = await wb.inspect({kind:'table',range:'候选评分!A4:Q9',include:'values,formulas',tableMaxRows:10,tableMaxCols:20,maxChars:10000});
await fs.writeFile(`${outputDir}/inspect_candidates.ndjson`, inspectCandidates.ndjson, 'utf8');
const errors = await wb.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A',options:{useRegex:true,maxResults:300},summary:'final formula error scan',maxChars:6000});
await fs.writeFile(`${outputDir}/formula_errors.ndjson`, errors.ndjson, 'utf8');

for (const [sheetName,range,file] of [
  ['仪表盘','A1:H16','preview_dashboard.png'],
  ['内容台账','A1:T12','preview_ledger.png'],
  ['候选评分','A1:Q9','preview_candidates.png'],
  ['每周复盘','A1:N9','preview_weekly.png'],
  ['评分规则','A1:E18','preview_scoring.png'],
]) {
  const blob = await wb.render({sheetName,range,scale:1.25,format:'png'});
  await fs.writeFile(`${outputDir}/${file}`, new Uint8Array(await blob.arrayBuffer()));
}

const xlsx = await SpreadsheetFile.exportXlsx(wb);
const finalPath = `${outputDir}/content_ledger.xlsx`;
await xlsx.save(finalPath);
await fs.copyFile(finalPath, projectCopy);
console.log(JSON.stringify({finalPath,projectCopy,sheets:5},null,2));
