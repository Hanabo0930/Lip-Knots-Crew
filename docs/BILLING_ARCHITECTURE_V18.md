# 課金基盤 v1.8

Stripe等の決済サービスを差し替えられるよう、決済プロバイダとアプリ本体を分離します。

保持する主な情報:

- customerId
- subscriptionId
- planCode
- billingStatus
- trialEnd
- currentPeriodEnd
- cancelAtPeriodEnd
- failureCount
- lastInvoiceId

カード番号やセキュリティコードは保持しません。
