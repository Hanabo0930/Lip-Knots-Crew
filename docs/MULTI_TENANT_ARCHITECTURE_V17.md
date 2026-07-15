# マルチテナント構成 v1.7

会社データは `tenants/{tenantId}` 配下へ完全分離します。認証クレームとtenantIdが一致しないアクセスは拒否し、SuperAdminのみ横断管理できます。
