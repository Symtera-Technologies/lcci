import type { ColumnType, Generated, Selectable } from "kysely";

/**
 * Typed schema for Kysely.
 *
 * Hand-written rather than generated. The DDL in `migrations/*.sql` is the
 * source of truth — controlling it by hand is the whole reason this project
 * uses Kysely over a TypeScript-first ORM, because collation, ENGINE, FULLTEXT
 * indexes and every MySQL-vs-MariaDB divergence have to be decided
 * deliberately on a host whose engine we do not choose. These interfaces are
 * the compile-time mirror of that DDL and must be edited in the same commit.
 *
 * Conventions:
 * - `Generated<T>` marks a column the database fills (AUTO_INCREMENT, DEFAULT).
 * - Instants are `DATETIME(3)` in UTC and surface as `Date`.
 * - Civil dates are `DATE` and surface as a "YYYY-MM-DD" string, because the
 *   pool sets `dateStrings: ["DATE"]`. See `src/db/pool.ts` for why that
 *   matters more than it looks.
 * - `DECIMAL` surfaces as a string. Money is not a float.
 * - `VARBINARY` surfaces as a Buffer.
 */

/**
 * DATETIME(3), UTC. The database default fills it when omitted.
 *
 * Not wrapped in `Generated<>`, and must not be: `Generated` is itself a
 * `ColumnType` that makes the insert type optional, so `Generated<Instant>`
 * nests one inside the other and the select type comes back as the ColumnType
 * rather than as `Date`. The optional insert is already encoded here.
 */
type Instant = ColumnType<Date, Date | undefined, Date>;
/** DATETIME(3) that is always written explicitly. */
type InstantSet = ColumnType<Date, Date, Date>;
/** DATE — a civil date, with no time and no zone. */
type CivilDate = ColumnType<string, string, string>;
/** JSON column. The shape is validated with zod at the boundary, never assumed. */
type Json = ColumnType<unknown, string, string>;

/* -------------------------------------------------------------------------- */
/* Migrations                                                                 */
/* -------------------------------------------------------------------------- */

export interface SchemaMigrationsTable {
  version: string;
  name: string;
  checksum: string;
  applied_at: Instant;
  applied_by: string;
}

/* -------------------------------------------------------------------------- */
/* Identity and access                                                        */
/* -------------------------------------------------------------------------- */

export type UserType = "staff" | "portal";
export type UserStatus = "invited" | "active" | "suspended" | "disabled";
export type MfaMode = "none" | "otp_email" | "otp_sms" | "totp";

export interface UsersTable {
  id: Generated<number>;
  user_type: UserType;
  email: string;
  mobile_e164: string | null;
  full_name: string;
  /** scrypt digest. NULL for portal users, who authenticate by OTP alone. */
  password_hash: string | null;
  /** AES-256-GCM ciphertext. The key lives in the environment, never the DB. */
  totp_secret_enc: Buffer | null;
  mfa_mode: Generated<MfaMode>;
  status: UserStatus;
  /**
   * Incremented on any change to roles, permissions, status, password, 2FA or
   * email — and when a member lapses or is suspended, so a lapsed member stops
   * being able to endorse immediately. Each session stores the version it was
   * minted with, so one integer comparison on a row already loaded invalidates
   * every session of that user at the instant of the change.
   */
  role_version: Generated<number>;
  email_verified_at: Instant | null;
  last_login_at: Instant | null;
  failed_logins: Generated<number>;
  locked_until: Instant | null;
  created_at: Instant;
  updated_at: Instant;
}

export type PermissionDomain = "content" | "membership" | "finance" | "admin";

export interface RolesTable {
  code: string;
  label_en: string;
  is_system: Generated<boolean>;
}

export interface PermissionsTable {
  code: string;
  label_en: string;
  domain: PermissionDomain;
}

export interface RolePermissionsTable {
  role_code: string;
  permission_code: string;
}

export type RoleScopeKind = "global" | "department" | "content_type";

export interface UserRolesTable {
  user_id: number;
  role_code: string;
  scope_kind: Generated<RoleScopeKind>;
  /**
   * NOT NULL with an empty-string default rather than nullable: MySQL treats
   * NULLs as distinct in a unique key, so a nullable scope would let the same
   * grant be inserted twice.
   */
  scope_value: Generated<string>;
  granted_by: number | null;
  granted_at: Instant;
}

export interface SessionsTable {
  /** sha256(token). The token itself exists only in the cookie. */
  id: string;
  user_id: number;
  user_type: UserType;
  role_version: number;
  created_at: Instant;
  last_seen_at: Instant;
  expires_at: InstantSet;
  /** Hard ceiling. Activity never extends this. */
  absolute_expires_at: InstantSet;
  mfa_satisfied_at: Instant | null;
  ip_hash: string | null;
  user_agent_hash: string | null;
  revoked_at: Instant | null;
}

export type OtpPurpose = "login" | "endorse" | "email_verify";

export interface OtpChallengesTable {
  id: Generated<number>;
  user_id: number | null;
  purpose: OtpPurpose;
  /** Hashed, so this table is not a list of who is signing in. */
  identifier_hash: string;
  /** The address or number the code was sent to, needed to re-send. */
  destination: string;
  /** sha256(code + salt). Never the code: this table is in every backup. */
  code_hash: string;
  salt: string;
  /** Binds the code to the browser that asked for it. */
  browser_nonce_hash: string | null;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  expires_at: InstantSet;
  consumed_at: Instant | null;
  created_ip_hash: string | null;
  created_at: Instant;
}

export type ThrottleAxis = "identifier" | "ip";

export interface LoginThrottleTable {
  /** `axis:sha256(subject)` */
  bucket: string;
  axis: ThrottleAxis;
  failures: Generated<number>;
  /**
   * Escalates 15m, 1h, 4h, 24h. Never permanent — a permanent lock is a denial
   * of service an attacker can trigger against any member they can name.
   */
  locked_until: Instant | null;
  escalation: Generated<number>;
  first_failure_at: Instant;
  last_failure_at: Instant;
}

export interface StaffTotpUsedTable {
  user_id: number;
  /** The RFC 6238 time step. Unique with user_id, so a code cannot be replayed. */
  step: number;
  used_at: Instant;
}

/**
 * Single-use recovery codes, for the staff member whose phone is gone.
 *
 * Hashed, never encrypted: nothing reads a code back, so a reversible store
 * would hold live credentials for no benefit. `used_at` rather than a DELETE,
 * because "this account burned four codes last month" is the signal that
 * someone is struggling with their authenticator — or that someone else has
 * their codes.
 */
export interface StaffRecoveryCodesTable {
  id: Generated<number>;
  user_id: number;
  /** scrypt digest, same format as `users.password_hash`. */
  code_hash: string;
  /** Position in the printed set, so a spent code can be named without storing it. */
  ordinal: number;
  used_at: Instant | null;
  used_ip_hash: string | null;
  created_at: Instant;
}

export interface CompaniesTable {
  id: Generated<number>;
  name: string;
  created_at: Instant;
}

export type CompanyUserRelation = "owner" | "staff" | "authorised_agent";

export interface CompanyUsersTable {
  company_id: number;
  user_id: number;
  relation: CompanyUserRelation;
  added_by: number | null;
  added_at: Instant;
}

/* -------------------------------------------------------------------------- */
/* Documents                                                                  */
/* -------------------------------------------------------------------------- */

export type DocumentSubjectKind =
  | "company"
  | "representative"
  | "director"
  | "endorser"
  | "payment";

export type DocumentReviewState =
  | "uploaded"
  | "accepted"
  | "rejected"
  | "superseded";

export type DocumentScanState = "pending" | "clean" | "infected" | "skipped";

export interface DocumentsTable {
  /** UUID, and the only public identifier. The row has no exposed surrogate. */
  id: string;
  application_id: number | null;
  membership_id: number | null;
  document_type_code: string;
  subject_kind: DocumentSubjectKind;
  subject_id: number | null;
  /**
   * The name the client sent. Data, never a path component — the stored path
   * derives from the UUID alone. It is also frequently the PII itself, since
   * `42201-1234567-8.jpg` is a CNIC number, which is the second reason it is
   * never logged and never used as a filename.
   */
  original_filename: string;
  /** Relative to `env.uploadRoot`. */
  storage_key: string;
  /** The sniffed type, never the declared one. Serving maps from this. */
  mime_type: string;
  byte_size: number;
  sha256: string;
  /** Header-parsed only. No pixel decode: sharp OOMs the worker on this plan. */
  pixel_width: number | null;
  pixel_height: number | null;
  page_count: number | null;
  /** For the "bank certificate not older than 3 months" rule. */
  issued_on: CivilDate | null;
  /**
   * Which cipher layout the stored bytes use. 1 = chunked AES-256-GCM.
   *
   * No per-file IV or tag column, deliberately: the IV prefix lives in the
   * file header and each 64 KB chunk carries its own tag. Whole-file GCM would
   * need both columns and would make Range requests impossible — which is the
   * one thing the review queue cannot do without.
   */
  cipher_version: number | null;
  /** The wrapped data key. The master key is in the environment. */
  encrypted_data_key: Buffer | null;
  scan_state: Generated<DocumentScanState>;
  review_state: Generated<DocumentReviewState>;
  review_note: string | null;
  reviewed_by: number | null;
  reviewed_at: Instant | null;
  /** A re-upload after a deficiency supersedes; it never overwrites. */
  supersedes_document_id: string | null;
  uploaded_by: number | null;
  uploaded_at: Instant;
  /** Soft only. Evidence is hard-deleted by the retention sweep and nothing else. */
  deleted_at: Instant | null;
}

export type DocumentAccessOutcome = "served" | "denied" | "not_found";

export interface DocumentAccessLogTable {
  id: Generated<number>;
  document_id: string;
  user_id: number | null;
  /**
   * Written on every fetch. A chamber holding identity documents will
   * eventually be asked "who looked at my CNIC", and this is the only thing
   * that can answer. It also lets a checklist item require that the officer
   * actually opened the original before ticking the box.
   */
  outcome: DocumentAccessOutcome;
  range_header: string | null;
  ip_hash: string | null;
  request_id: string;
  at: Instant;
}

/* -------------------------------------------------------------------------- */
/* Audit                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The chain's head, as one permanent row.
 *
 * Exists so that a writer has something to lock even when `audit_log` is
 * empty — see migration 0006. A denormalised pointer, rebuildable from the log
 * at any time; the log remains the evidence.
 */
export interface AuditChainHeadTable {
  id: number;
  head_hash: string | null;
  head_id: number | null;
  updated_at: Instant;
}

export interface AuditLogTable {
  id: Generated<number>;
  occurred_at: Instant;
  /**
   * One ULID per HTTP request. A single approval writes a decision event, a
   * membership-created event, a number-allocated event and an SLA-stopped
   * event; without this they are four unrelated rows in a table of millions.
   */
  request_id: string;
  /** NULL means the actor was the system — a cron job. */
  actor_user_id: number | null;
  /**
   * Snapshotted, not joined. The role someone held when they approved
   * something is a historical fact; their current roles are not, and a join
   * would rewrite history on every promotion.
   */
  actor_role_code: string | null;
  actor_ip_hash: string | null;
  actor_user_agent_hash: string | null;
  on_behalf_of_user_id: number | null;
  entity_type: string;
  entity_id: string;
  action: string;
  summary: string;
  before_json: Json | null;
  after_json: Json | null;
  context_json: Json | null;
  form_revision_id: number | null;
  /** Hash chain. It does not prevent tampering; it makes tampering detectable. */
  prev_hash: string | null;
  row_hash: string;
}

/* -------------------------------------------------------------------------- */
/* Infrastructure                                                             */
/* -------------------------------------------------------------------------- */

export type EmailState = "pending" | "sending" | "sent" | "failed" | "dead";

export interface EmailOutboxTable {
  id: Generated<number>;
  to_address: string;
  template: string;
  payload_json: Json;
  channel: Generated<string>;
  entity_type: string | null;
  entity_id: string | null;
  state: Generated<EmailState>;
  attempts: Generated<number>;
  next_attempt_at: Instant;
  last_error: string | null;
  locked_at: Instant | null;
  locked_by: string | null;
  created_at: Instant;
  sent_at: Instant | null;
}

export type JobState = "idle" | "running" | "failed";

export interface JobRunsTable {
  job: string;
  state: Generated<JobState>;
  run_id: string | null;
  started_at: Instant | null;
  finished_at: Instant | null;
  /**
   * Refreshed inside long jobs. The claim condition treats a stale heartbeat
   * as unlocked, because a worker killed mid-run by the shared plan's CPU
   * limiter would otherwise hold the lock forever.
   */
  heartbeat_at: Instant | null;
  last_summary: Json | null;
}

export interface RateLimitCountersTable {
  /** `scope:subject:windowStart` */
  bucket: string;
  hits: Generated<number>;
  window_started_at: InstantSet;
  expires_at: InstantSet;
}

export interface RateLimitEventsTable {
  id: Generated<number>;
  bucket: string;
  at: Instant;
}

export interface CspReportsTable {
  id: Generated<number>;
  document_uri: string | null;
  violated_directive: string | null;
  blocked_uri: string | null;
  disposition: string | null;
  raw_json: Json;
  received_at: Instant;
}

/* -------------------------------------------------------------------------- */
/* Membership: reference data                                                 */
/* -------------------------------------------------------------------------- */

export type MembershipClass = "corporate" | "associate";
export type ProcessingTier = "regular" | "urgent" | "executive";
export type FeeKind = "membership" | "itd_surcharge";
export type DocumentCardinality = "one" | "all_directors" | "optional";
export type CalendarConfidence = "confirmed" | "provisional";
export type SequenceResets = "never" | "yearly";

export interface FormRevisionsTable {
  id: Generated<number>;
  iso_doc_code: string;
  revision: string;
  effective_from: CivilDate;
  retired_on: CivilDate | null;
  note: string | null;
}

export interface CompanyStatusesTable {
  code: string;
  label_en: string;
  label_ur: string | null;
  sort_order: Generated<number>;
  active: Generated<number>;
}

export interface BusinessTypesTable {
  code: string;
  label_en: string;
  label_ur: string | null;
  sort_order: Generated<number>;
  active: Generated<number>;
}

export interface DocumentTypesTable {
  code: string;
  label_en: string;
  label_ur: string | null;
  subject_kind: DocumentSubjectKind;
  /** Set only for the bank certificate, whose three-month limit is policy. */
  max_age_days: number | null;
  requires_issued_on: Generated<number>;
  allows_multiple: Generated<number>;
  guidance_en: string | null;
  sort_order: Generated<number>;
  active: Generated<number>;
}

export interface DocumentRequirementsTable {
  id: Generated<number>;
  company_status_code: string;
  document_type_code: string;
  cardinality: Generated<DocumentCardinality>;
  note_en: string | null;
}

export interface FeeScheduleTable {
  id: Generated<number>;
  fee_kind: Generated<FeeKind>;
  /** Null on the ITD surcharge, which applies to any class. */
  membership_class: MembershipClass | null;
  processing_tier: ProcessingTier | null;
  /** DECIMAL(14,2) — a string, because money is not a float. */
  amount: string;
  currency: Generated<string>;
  /** The paid promise: 40, 15 or 3. Null on the surcharge. */
  working_days: number | null;
  effective_from: CivilDate;
  effective_to: CivilDate | null;
  label_en: string;
}

export interface MembershipYearPolicyTable {
  id: number;
  expires_on_month: number;
  expires_on_day: number;
  carry_forward_month: number | null;
  carry_forward_day: number | null;
  note: string | null;
  updated_at: InstantSet;
}

export interface WorkingDayCalendarTable {
  cal_date: CivilDate;
  is_working_day: number;
  label_en: string | null;
  confidence: Generated<CalendarConfidence>;
  source: string | null;
  notified_on: CivilDate | null;
  updated_at: InstantSet;
}

export interface NumberSequencesTable {
  name: string;
  pattern: string;
  next_value: Generated<number>;
  pad_width: Generated<number>;
  resets: Generated<SequenceResets>;
  period_key: string | null;
  updated_at: InstantSet;
}

/* -------------------------------------------------------------------------- */
/* Membership: the application aggregate                                      */
/* -------------------------------------------------------------------------- */

/**
 * The internal machine's states.
 *
 * Twelve, against the four labels the applicant is shown. `publicStage()` in
 * `src/membership/workflow.ts` derives the label; it is never stored, because
 * storing both invites them to disagree.
 */
export type ApplicationState =
  | "DRAFT"
  | "SUBMITTED"
  | "UNDER_VERIFICATION"
  | "VERIFIED"
  | "PENDING_APPROVAL"
  | "AWAITING_APPLICANT"
  | "APPROVED"
  | "REJECTED"
  | "WITHDRAWAL_REQUESTED"
  | "WITHDRAWN"
  | "DRAFT_EXPIRED"
  | "CLOSED_NO_RESPONSE";

export type EndorsementMode = "in_app" | "signed_sheet";
export type PremisesTenure = "owned" | "rented";

export interface ApplicationsTable {
  id: Generated<number>;
  /** Assigned at submission, never before. */
  public_ref: string | null;
  state: Generated<ApplicationState>;
  /** Optimistic concurrency; every transition compares and bumps it. */
  version: Generated<number>;
  created_by: number;
  company_id: number | null;
  membership_class: MembershipClass | null;
  processing_tier: ProcessingTier | null;
  company_status_code: string | null;
  form_revision_id: number | null;
  fee_schedule_id: number | null;
  requires_itd_surcharge: Generated<number>;
  endorsement_mode: EndorsementMode | null;
  assigned_to: number | null;
  /** Values that could not be coerced into their typed column. */
  wizard_scratch: Json | null;
  wizard_step: Generated<number>;
  submitted_at: Date | null;
  decided_at: Date | null;
  expires_at: Date | null;
  created_at: Instant;
  updated_at: Instant;
}

/**
 * The sixteen numbered fields, as a 1:1 satellite.
 *
 * Every column nullable. Autosave and NOT NULL cannot coexist — completeness
 * is enforced at the submit transition by a zod schema, never by the schema.
 */
export interface ApplicationCompanyTable {
  application_id: number;
  firm_name: string | null;
  representative_name: string | null;
  representative_cnic_enc: Buffer | null;
  representative_cnic_hmac: string | null;
  representative_passport_enc: Buffer | null;
  representative_passport_hmac: string | null;
  representative_dob: CivilDate | null;
  representative_birthplace: string | null;
  representative_nationality: string | null;
  postal_address: string | null;
  premises_tenure: PremisesTenure | null;
  email: string | null;
  office_phone_1: string | null;
  office_phone_2: string | null;
  fax: string | null;
  representative_mobile_1: string | null;
  representative_mobile_2: string | null;
  /** DECIMAL(16,2) as a string. The Corporate threshold is Rs 50m exactly. */
  paid_up_capital: string | null;
  annual_turnover: string | null;
  employee_count: number | null;
  ntn_enc: Buffer | null;
  ntn_hmac: string | null;
  strn_registered: number | null;
  strn_enc: Buffer | null;
  business_sector: string | null;
  business_sub_sector: string | null;
  main_commodity: string | null;
  bank_name: string | null;
  bank_branch: string | null;
  updated_at: Instant;
}

export interface ApplicationBusinessTypesTable {
  application_id: number;
  business_type_code: string;
}

export interface ApplicationDirectorsTable {
  id: Generated<number>;
  application_id: number;
  position: Generated<number>;
  full_name: string | null;
  designation: string | null;
  membership_no: string | null;
  cell: string | null;
  cnic_enc: Buffer | null;
  cnic_hmac: string | null;
  passport_enc: Buffer | null;
  ntn_enc: Buffer | null;
  is_foreign_national: Generated<number>;
  /** The attesting director, who must not be the representative. */
  attests: Generated<number>;
  created_at: Instant;
  updated_at: Instant;
}

export type EndorsementRole = "proposer" | "seconder";
export type EndorsementState =
  | "invited"
  | "endorsed"
  | "declined"
  | "expired"
  | "superseded";
/** Snapshotted at endorsement and re-checked at approval. */
export type EndorserStanding = "active" | "lapsed" | "suspended" | "unknown";

export interface ApplicationEndorsementsTable {
  id: Generated<number>;
  application_id: number;
  role: EndorsementRole;
  firm_name: string | null;
  membership_no: string | null;
  representative_name: string | null;
  mobile: string | null;
  email: string | null;
  endorser_user_id: number | null;
  state: Generated<EndorsementState>;
  standing_at_endorsement: EndorserStanding | null;
  standing_at_approval: EndorserStanding | null;
  endorsed_at: Date | null;
  otp_challenge_id: number | null;
  endorsed_ip_hash: string | null;
  endorsed_ua_hash: string | null;
  /** The exact wording agreed to. Evidence is only evidence if it is kept. */
  declaration_text: string | null;
  invited_at: Date | null;
  reminded_at: Date | null;
  created_at: Instant;
  updated_at: Instant;
}

export interface ApplicationAuthorisationTable {
  application_id: number;
  declaration_accepted_at: Date | null;
  declaration_text: string | null;
  declared_by: number | null;
  declared_ip_hash: string | null;
  declared_ua_hash: string | null;
  attested_by_director_id: number | null;
  attested_at: Date | null;
  updated_at: Instant;
}

export interface ApplicationRequiredDocumentsTable {
  id: Generated<number>;
  application_id: number;
  document_type_code: string;
  cardinality: DocumentCardinality;
  /** 'all_directors' resolved against the actual board size at submission. */
  required_count: Generated<number>;
  note_en: string | null;
  satisfied_at: Date | null;
}

export interface ApplicationStateTransitionsTable {
  id: Generated<number>;
  application_id: number;
  from_state: string | null;
  to_state: string;
  transition_code: string;
  actor_user_id: number | null;
  actor_role_code: string | null;
  reason: string | null;
  request_id: string;
  occurred_at: Instant;
}

export interface SubmissionSnapshotsTable {
  id: Generated<number>;
  application_id: number;
  round: Generated<number>;
  form_revision_id: number;
  /** Canonical JSON: keys sorted, so the hash is reproducible. */
  payload_json: Json;
  payload_sha256: string;
  created_by: number | null;
  request_id: string;
  created_at: Instant;
}

/* -------------------------------------------------------------------------- */
/* Verification: the thirteen-item checklist and the deficiency round          */
/* -------------------------------------------------------------------------- */

/**
 * Whether a tick clears the item or blocks it.
 *
 * Items 1 ("Incomplete form") and 13 ("Signatures do not match with CNIC") are
 * defects. Everything that reads a checklist has to know this, which is why it
 * is a column on both the definition and every recorded item rather than a
 * rule in one function somewhere.
 */
export type ChecklistPolarity = "compliance" | "defect";

export interface ChecklistItemDefinitionsTable {
  id: Generated<number>;
  form_revision_id: number;
  code: string;
  ordinal: number;
  label_en: string;
  label_ur: string | null;
  polarity: Generated<ChecklistPolarity>;
  /** Set on item 3 alone: proved by a `document_access_log` row. */
  requires_document_view: Generated<number>;
  note_required_on_fail: Generated<number>;
  active: Generated<number>;
}

export interface ChecklistItemDocumentTypesTable {
  definition_id: number;
  document_type_code: string;
}

export type ChecklistState = "in_progress" | "completed" | "superseded";
export type ChecklistOutcome = "clear" | "deficient";

export interface VerificationChecklistsTable {
  id: Generated<number>;
  application_id: number;
  round: Generated<number>;
  form_revision_id: number;
  state: Generated<ChecklistState>;
  /** Derived at completion and then frozen, never recomputed on read. */
  outcome: ChecklistOutcome | null;
  started_by: number | null;
  started_at: Instant;
  completed_by: number | null;
  completed_at: Date | null;
  completed_by_role_code: string | null;
  request_id: string;
  created_at: Instant;
  updated_at: Instant;
}

/** What the item means, once polarity has been applied to the tick. */
export type ChecklistItemOutcome = "pass" | "fail" | "not_applicable";
/** The machine's opinion. 'unknown' for a wet signature or a company stamp. */
export type ChecklistSystemVerdict = "pass" | "fail" | "unknown";

export interface VerificationChecklistItemsTable {
  id: Generated<number>;
  checklist_id: number;
  item_code: string;
  /** Copied, not joined: a 2026 checklist renders with its own wording. */
  ordinal: number;
  label_en: string;
  polarity: ChecklistPolarity;
  /** Literally whether the box was ticked. `outcome` is what it means. */
  marked: Generated<number>;
  outcome: ChecklistItemOutcome;
  note: string | null;
  system_verdict: Generated<ChecklistSystemVerdict>;
  decided_by: number | null;
  decided_at: Instant;
}

export interface VerificationItemDocumentsTable {
  checklist_item_id: number;
  document_id: string;
}

export type DeficiencyState = "open" | "answered" | "cancelled";
export type DeficiencyItemKind = "document" | "field" | "other";

export interface ApplicationDeficienciesTable {
  id: Generated<number>;
  application_id: number;
  round: Generated<number>;
  checklist_id: number | null;
  state: Generated<DeficiencyState>;
  summary: string | null;
  raised_by: number | null;
  raised_at: Instant;
  /** A civil date: it is quoted in an email and must not shift a day. */
  respond_by: CivilDate | null;
  reminder_count: Generated<number>;
  last_reminded_at: Date | null;
  answered_at: Date | null;
  /** The pause stretch this deficiency opened, so resuming closes the right one. */
  sla_pause_id: number | null;
  request_id: string;
  created_at: Instant;
  updated_at: Instant;
}

export interface DeficiencyItemsTable {
  id: Generated<number>;
  deficiency_id: number;
  kind: DeficiencyItemKind;
  document_type_code: string | null;
  subject_kind: DocumentSubjectKind | null;
  subject_id: number | null;
  /** The wizard's own field vocabulary, so unlocking and routing agree. */
  field_name: string | null;
  checklist_item_code: string | null;
  instruction: string;
  resolved_at: Date | null;
  resolved_document_id: string | null;
  created_at: Instant;
}

/* -------------------------------------------------------------------------- */
/* Membership: money and the SLA clock                                        */
/* -------------------------------------------------------------------------- */

export type PaymentState =
  | "due"
  | "instrument_received"
  | "receipted"
  | "dishonoured"
  | "refunded"
  | "waived"
  | "cancelled";
export type PaymentMethod = "pay_order" | "cash" | "cheque" | "online";
export type RefundDisposition =
  | "pending_decision"
  | "refund_due"
  | "forfeited"
  | "refunded";

export interface PaymentsTable {
  id: Generated<number>;
  application_id: number;
  fee_kind: FeeKind;
  fee_schedule_id: number | null;
  amount: string;
  currency: Generated<string>;
  fx_rate: string | null;
  fx_rate_date: CivilDate | null;
  fx_authority: string | null;
  amount_pkr: string | null;
  state: Generated<PaymentState>;
  method: PaymentMethod | null;
  received_at: Date | null;
  receipted_at: Date | null;
  /** Who receipted it. Approval refuses this user, as separation of duties. */
  receipted_by: number | null;
  receipt_no: string | null;
  dishonoured_at: Date | null;
  dishonour_reason: string | null;
  refund_disposition: RefundDisposition | null;
  version: Generated<number>;
  created_at: Instant;
  updated_at: Instant;
}

/** Advisory only: "HBL" and "Habib Bank Ltd" are the same bank. */
export type BankMatchSystem = "match" | "mismatch" | "uncertain";
/** The officer's judgement, which is what approval is guarded on. */
export type BankMatchVerdict = "match" | "mismatch";

export interface PayOrdersTable {
  id: Generated<number>;
  payment_id: number;
  drawee_bank_name: string;
  drawee_branch: string | null;
  instrument_no: string;
  instrument_date: CivilDate;
  instrument_amount: string;
  instrument_currency: Generated<string>;
  account_title: string | null;
  certificate_bank_name: string | null;
  certificate_branch: string | null;
  certificate_account_title: string | null;
  certificate_issued_on: CivilDate | null;
  bank_match_system: BankMatchSystem | null;
  bank_match_verdict: BankMatchVerdict | null;
  bank_match_verdict_by: number | null;
  bank_match_verdict_at: Date | null;
  bank_match_note: string | null;
  /** SHA-256 of the normalised instrument triple; catches a reused pay order. */
  instrument_fingerprint: string;
  created_at: Instant;
  updated_at: Instant;
}

export type SlaState = "running" | "paused" | "stopped";
export type SlaOutcome = "met" | "breached";
export type SlaPauseReason =
  | "awaiting_applicant"
  | "awaiting_originals"
  | "awaiting_endorsement"
  | "awaiting_payment"
  | "office_closure"
  | "other";

export interface SlaClocksTable {
  id: Generated<number>;
  application_id: number;
  processing_tier: ProcessingTier;
  working_days: number;
  started_at: InstantSet;
  /** Materialised at submission. A civil date, because it is quoted. */
  due_date: CivilDate;
  state: Generated<SlaState>;
  outcome: SlaOutcome | null;
  stopped_at: Date | null;
  elapsed_working_days: Generated<number>;
  paused_working_days: Generated<number>;
  needs_recompute: Generated<number>;
  created_at: Instant;
  updated_at: Instant;
}

export interface SlaPausesTable {
  id: Generated<number>;
  sla_clock_id: number;
  reason: SlaPauseReason;
  note: string | null;
  paused_at: InstantSet;
  resumed_at: Date | null;
  working_days_cost: number | null;
}

/* -------------------------------------------------------------------------- */
/* The database                                                               */
/* -------------------------------------------------------------------------- */

export interface Database {
  schema_migrations: SchemaMigrationsTable;

  users: UsersTable;
  roles: RolesTable;
  permissions: PermissionsTable;
  role_permissions: RolePermissionsTable;
  user_roles: UserRolesTable;
  sessions: SessionsTable;
  otp_challenges: OtpChallengesTable;
  login_throttle: LoginThrottleTable;
  staff_totp_used: StaffTotpUsedTable;
  staff_recovery_codes: StaffRecoveryCodesTable;
  companies: CompaniesTable;
  company_users: CompanyUsersTable;

  documents: DocumentsTable;
  document_access_log: DocumentAccessLogTable;

  audit_log: AuditLogTable;
  audit_chain_head: AuditChainHeadTable;

  form_revisions: FormRevisionsTable;
  company_statuses: CompanyStatusesTable;
  business_types: BusinessTypesTable;
  document_types: DocumentTypesTable;
  document_requirements: DocumentRequirementsTable;
  fee_schedule: FeeScheduleTable;
  membership_year_policy: MembershipYearPolicyTable;
  working_day_calendar: WorkingDayCalendarTable;
  number_sequences: NumberSequencesTable;

  applications: ApplicationsTable;
  application_company: ApplicationCompanyTable;
  application_business_types: ApplicationBusinessTypesTable;
  application_directors: ApplicationDirectorsTable;
  application_endorsements: ApplicationEndorsementsTable;
  application_authorisation: ApplicationAuthorisationTable;
  application_required_documents: ApplicationRequiredDocumentsTable;
  application_state_transitions: ApplicationStateTransitionsTable;
  submission_snapshots: SubmissionSnapshotsTable;

  checklist_item_definitions: ChecklistItemDefinitionsTable;
  checklist_item_document_types: ChecklistItemDocumentTypesTable;
  verification_checklists: VerificationChecklistsTable;
  verification_checklist_items: VerificationChecklistItemsTable;
  verification_item_documents: VerificationItemDocumentsTable;
  application_deficiencies: ApplicationDeficienciesTable;
  deficiency_items: DeficiencyItemsTable;

  payments: PaymentsTable;
  pay_orders: PayOrdersTable;
  sla_clocks: SlaClocksTable;
  sla_pauses: SlaPausesTable;

  email_outbox: EmailOutboxTable;
  job_runs: JobRunsTable;
  rate_limit_counters: RateLimitCountersTable;
  rate_limit_events: RateLimitEventsTable;
  csp_reports: CspReportsTable;
}

export type ApplicationRow = Selectable<ApplicationsTable>;
export type ApplicationCompanyRow = Selectable<ApplicationCompanyTable>;
export type ApplicationDirectorRow = Selectable<ApplicationDirectorsTable>;
export type ApplicationEndorsementRow = Selectable<ApplicationEndorsementsTable>;
export type FeeScheduleRow = Selectable<FeeScheduleTable>;
export type PaymentRow = Selectable<PaymentsTable>;
export type SlaClockRow = Selectable<SlaClocksTable>;

export type UserRow = Selectable<UsersTable>;
export type SessionRow = Selectable<SessionsTable>;
export type DocumentRow = Selectable<DocumentsTable>;
