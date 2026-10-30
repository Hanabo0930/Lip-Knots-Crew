/* Entry into the existing authenticated Admin recruitment formatter.
 * Source preparation only. No business rows, mail, triggers or scopes added.
 * Configure LK_RM_SOURCE_BOOK_ID privately after reviewing the deployment.
 */
var LK_RM_ADMIN_ORIGIN_V1 = 'https://lip-knots-crew-staging-admin.web.app';
function lkRmV1EntryBinding_() {
  var sourceBookId = PropertiesService.getScriptProperties().getProperty('LK_RM_SOURCE_BOOK_ID');
  var book = SpreadsheetApp.getActiveSpreadsheet();
  if (typeof sourceBookId !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(sourceBookId) || !book || book.getId() !== sourceBookId) {
    throw new Error('案件メール作成の対象設定を確認してください。');
  }
  return book;
}
function lkRmV1Open() {
  lkRmV1EntryBinding_();
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutputFromFile('RecruitMailDialog').setWidth(540).setHeight(390), '案件メール作成');
}
function lkRmV1Bootstrap() {
  lkRmV1EntryBinding_();
  if (LK_RM_ADMIN_ORIGIN_V1 !== 'https://lip-knots-crew-staging-admin.web.app') {
    throw new Error('募集メール作成画面の接続先を確認してください。');
  }
  return { purpose: 'recruitment-admin-entry', url: LK_RM_ADMIN_ORIGIN_V1 + '/?entry=recruitment-mail' };
}
// Cached copies of the old dialog cannot invoke the legacy extractor.
function lkRmV1Generate() {
  throw new Error('この作成画面は更新されました。画面を閉じ、案件メール作成を開き直してください。');
}
// Retain the existing menu hook. Do not add a second onOpen or trigger.
function lkRmV1AddMenu_() {
  try { lkRmV1EntryBinding_(); } catch (_) { return; }
  SpreadsheetApp.getUi().createMenu('案件メール作成').addItem('作成画面を開く', 'lkRmV1Open').addToUi();
}
