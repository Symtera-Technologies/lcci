-- Enquiries from the website's contact form.
--
-- ## Why this table exists at all
--
-- The contact page carried a written refusal to build a form until there was
-- "a staff inbox and an owner for it", on the grounds that a form which posts
-- nowhere is worse than a published address: the visitor believes they have
-- been heard. That reasoning does not stop at the point where mail is wired
-- up, because mail is the part that fails quietly. An SMTP password rotated by
-- the host, an expired certificate, a domain whose reputation slipped — each
-- of those drops enquiries with no symptom the chamber can see, and the only
-- person who knows is the one who cannot be told.
--
-- So the submission is committed here first and the email is sent second. The
-- email is how staff find out; this is how nothing is lost when it doesn't
-- arrive. `email_outbox` is not a substitute: it retries five times over about
-- five hours, then marks the row `dead`, and the retention sweep overwrites
-- its payload after thirty days. That is a queue, correctly behaving as one.
--
-- ## What is deliberately not here
--
-- No status, no assignee, no reply thread. The chamber's inbox is the
-- workflow — staff read the mail and press reply — and a second status column
-- that nobody updates would make the admin screen lie about which enquiries
-- had been answered. If LCCI later wants triage in the panel, that is a
-- decision with an owner, and it gets its own migration.
--
-- ## Personal data
--
-- Every row is a name, an address and whatever someone chose to write. It
-- therefore falls under the retention question the rest of the system is
-- waiting on (plan open question 7); 24 months is the proposed default and
-- nothing here assumes indefinite. The IP is stored hashed with the same
-- pepper the rate limiter uses, so this is not an address log either — it is
-- only enough to recognise one source submitting a hundred times.
CREATE TABLE contact_messages (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Quoted to the sender in their acknowledgement and to staff in the subject
  -- line, so it has to be short enough to read down a telephone and read back.
  -- Generated in the application from a crypto source, not derived from the
  -- id: a sequential reference tells anyone who submits twice how much mail
  -- the chamber receives, and invites guessing at other people's.
  reference       CHAR(10) NOT NULL,

  -- One of the form's own topic codes, not free text. It reaches a mail
  -- subject line, and the set is closed in `src/content/contact-topics.ts`.
  topic           VARCHAR(40) NOT NULL,

  sender_name     VARCHAR(120) NOT NULL,
  sender_email    VARCHAR(190) NOT NULL,
  sender_phone    VARCHAR(40) NULL,
  organisation    VARCHAR(190) NULL,

  -- TEXT, not VARCHAR. The form caps the message at 4000 characters, which
  -- fits either; TEXT is chosen so raising that cap is not a migration on a
  -- table that will by then hold real correspondence.
  body            TEXT NOT NULL,

  -- Which language the form was in, for whoever answers it.
  locale          CHAR(2) NOT NULL DEFAULT 'en',

  ip_hash         CHAR(64) NULL,
  user_agent_hash CHAR(64) NULL,

  -- The queued notification to the chamber. Not a foreign key: the outbox is
  -- infrastructure with its own retention, and an enquiry must survive its
  -- notification being swept. Null means the send was never queued, which is
  -- itself worth seeing on the admin screen.
  outbox_id       BIGINT UNSIGNED NULL,

  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  UNIQUE KEY uq_contact_reference (reference),
  KEY idx_contact_recent (created_at),
  KEY idx_contact_topic (topic, created_at),
  -- "Has this person written before?", which is the question staff actually
  -- ask when the same enquiry arrives for the third time.
  KEY idx_contact_sender (sender_email, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
