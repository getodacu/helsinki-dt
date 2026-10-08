import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';

test('pinned workbook format preserves string IDs with patched UUID dependency', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sample');
  sheet.addRow(['Identifier', 'Value']);
  sheet.addRow(['001', 12.5]);
  sheet.addConditionalFormatting({ ref: 'B2', rules: [{ type: 'iconSet', iconSet: '3Stars',
    cfvo: [{ type: 'min' }, { type: 'percent', value: 50 }, { type: 'max' }], priority: 1 }] });
  const bytes = await workbook.xlsx.writeBuffer();
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(bytes);
  assert.equal(loaded.worksheets[0].getCell('A2').value, '001');
  assert.equal(loaded.worksheets[0].getCell('B2').value, 12.5);
});
