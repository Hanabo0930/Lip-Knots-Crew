# 新規行追加の設定 v1.1

設定先:

`companies/{companyId}/sheetMappings/shift`

```json
{
  "enabled": false,
  "spreadsheetId": "実スプシID",
  "idColumn": "ZZ",
  "columns": {
    "workDate": "A",
    "staffName": "B",
    "clientName": "J",
    "storeName": "K",
    "makerName": "L",
    "menuName": "M",
    "entryTime": "N",
    "workTime": "O",
    "subcontractorName": "P",
    "staffBasePay": "AB",
    "caseId": "ZZ"
  },
  "rowCreation": {
    "enabled": false,
    "headerRow": 1,
    "dataStartRow": 2,
    "maxRows": 10000,
    "rowEndColumn": "ZZ",
    "formulaColumns": ["AA", "AJ", "AR", "BB"],
    "requiredValidationColumns": [],
    "copyFormat": true,
    "copyFormula": true,
    "copyDataValidation": true,
    "cloneConditionalFormatting": true,
    "rollbackOnVerificationFailure": true
  }
}
```

## requiredValidationColumns

監査で必須と判断した列だけを登録します。

例:

```json
["B", "BC", "BE", "BF"]
```

空配列でも入力規則そのものは雛形行からコピーします。
空配列の場合は、書込後の必須検算だけを省略します。

## 有効化条件

次の3つがすべてtrueの場合だけ、管理画面の新規案件をスプシへ追加します。

- `sheetMappings.shift.enabled`
- `sheetMappings.shift.rowCreation.enabled`
- `companyFeatureSettings.adminJobCreationSourceReady`
