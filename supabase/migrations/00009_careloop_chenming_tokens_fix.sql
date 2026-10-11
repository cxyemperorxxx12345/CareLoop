-- GoTrue 要求 token 列为空串而非 NULL（对齐 guifang 建号模式）
UPDATE auth.users
SET confirmation_token = '', email_change = '', email_change_token_new = '', recovery_token = ''
WHERE email = 'chenming@miaoda.com' AND (confirmation_token IS NULL OR email_change IS NULL OR email_change_token_new IS NULL OR recovery_token IS NULL);