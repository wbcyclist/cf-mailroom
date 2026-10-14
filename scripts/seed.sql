-- Local development seed data. Run: npm run db:seed:local
INSERT INTO domains (name, status, activated_at) VALUES
  ('yourdomain.com', 'active', now()),
  ('otherdomain.com', 'active', now());

INSERT INTO mailboxes (address, domain_id, color, agent_mode, agent_instructions) VALUES
  ('support@yourdomain.com', 1, '#6366f1', 'off', 'Product A is a subscription service for independent creators. Be warm, concise, and transparent. Never claim an action was completed unless it has been verified.'),
  ('help@otherdomain.com', 2, '#10b981', 'off', 'Product B is an account management service. Reply clearly and ask one focused question at a time.');

INSERT INTO playbooks (mailbox_id, name, when_to_use, instructions, example_reply, enabled) VALUES
  ((SELECT id FROM mailboxes WHERE address = 'support@yourdomain.com'), 'Refund requests', 'Use when a customer asks to cancel a charge, reverse a payment, or receive a refund.', 'Acknowledge the request. State only facts confirmed in the conversation. If the payment cannot be verified, ask for the billing email. Do not promise an exact arrival date.', 'Thanks for reaching out. I found the charge and have submitted the refund. It usually appears on the original payment method within 5–10 business days.', 1),
  ((SELECT id FROM mailboxes WHERE address = 'support@yourdomain.com'), 'Duplicate charges', 'Use when a customer reports being charged more than once for the same purchase.', 'Confirm which charges are duplicates before promising a refund. Explain which charge will remain and give a realistic processing window.', NULL, 1);

INSERT INTO threads (mailbox_id, subject, normalized_subject, snippet, is_read, message_count, last_message_at) VALUES
  (1, 'Refund request for order #1234', 'refund request for order #1234', 'Hi, I was charged twice for my subscription last week...', 0, 1, now()),
  (2, 'Cannot log in to my account', 'cannot log in to my account', 'I keep getting an invalid password error even after reset...', 1, 2, now() - interval '1 hour');

INSERT INTO messages (thread_id, message_id, direction, sent_by, from_address, from_name, to_addresses, subject, text_body) VALUES
  (1, '<seed-msg-1@example.com>', 'inbound', 'external', 'customer@example.com', 'Alice Customer', '["support@yourdomain.com"]', 'Refund request for order #1234', 'Hi, I was charged twice for my subscription last week. Could you check order #1234 and refund the duplicate charge? Thanks!'),
  (2, '<seed-msg-2@example.com>', 'inbound', 'external', 'bob@example.com', 'Bob User', '["help@otherdomain.com"]', 'Cannot log in to my account', 'I keep getting an invalid password error even after reset. My account email is bob@example.com.'),
  (2, '<seed-msg-3@example.com>', 'outbound', 'human', 'help@otherdomain.com', NULL, '["bob@example.com"]', 'Re: Cannot log in to my account', 'Hi Bob, sorry about that. Could you tell me roughly when you last logged in successfully?'),
  (2, '<seed-msg-4@example.com>', 'inbound', 'external', 'bob@example.com', 'Bob User', '["help@otherdomain.com"]', 'Re: Cannot log in to my account', 'Last Tuesday, I think. It broke after I changed my email.

On Thu, Aug 20, 2026 at 9:00 PM Product B Support <help@otherdomain.com> wrote:
> Hi Bob, sorry about that. Could you tell me roughly when you last
> logged in successfully?');

INSERT INTO drafts (thread_id, text_body, created_by, agent_notes, playbook_id, status) VALUES
  (1, 'Hi Alice,

Thanks for reaching out. I checked order #1234 and confirmed a duplicate charge on your subscription. I''ve issued a refund for the second charge — it should appear on your statement within 5-7 business days.

Best,
Product A Support', 'agent', 'Looked up order #1234 in Stripe: two identical charges 3 minutes apart on the same card. Classic double-submit. Refunded the newer one.', 1, 'pending');

UPDATE drafts SET source_inbound_message_id = (SELECT id FROM messages WHERE message_id = '<seed-msg-1@example.com>');
UPDATE threads SET message_count = (SELECT count(*) FROM messages WHERE thread_id = threads.id);
