SELECT cron.schedule(
  'careloop-reminder-scan',
  '* * * * *',
  $$ SELECT net.http_post(
       url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/reminder-scan',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'apikey', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'publishable_key')
       ),
       body := jsonb_build_object('time', now())
     ) AS request_id; $$
);