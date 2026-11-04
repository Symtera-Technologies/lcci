-- Point the CMS-held membership links at the Chamber's own portal.
--
-- The Chamber asked for the rebuilt site to be content only: joining, signing
-- in, paying a fee and renewing all stay on membership.lcci.org.pk, which is
-- where lcci.com.pk sends people today. The code side of that switch is
-- `src/membership/portal.ts`; this migration handles the three links that are
-- content rather than code, so flipping the flag alone would leave them
-- pointing at routes the proxy now redirects away.
--
-- Scoped to rows still holding the seeded value, in every statement. An editor
-- who has already changed one of these in the admin had a reason, and a
-- migration that overwrites hand-edited content is a migration that loses
-- somebody's work silently.
--
-- `0023_seed_hero.sql` and `0017_seed_content.sql` are applied and checksummed,
-- so they cannot be edited in place; this is a forward correction instead.
--
-- To reverse: set these three back to '/membership/register',
-- '/membership/sign-in' and '/membership/renew' respectively, and set
-- MEMBERSHIP_PORTAL_ENABLED to true.

-- The homepage hero's first button. `0027_hero_cta_register.sql` moved it from
-- '/membership/apply' to '/membership/register'; both are matched here so the
-- statement works whether or not 0027 ran.
UPDATE content_heroes
   SET primary_cta_href = 'https://membership.lcci.org.pk/register'
 WHERE primary_cta_href IN ('/membership/register', '/membership/apply');

-- The quiet "Already a member?" line under the hero buttons.
UPDATE content_heroes
   SET member_link_href = 'https://membership.lcci.org.pk/member-login/'
 WHERE member_link_href = '/membership/sign-in';

-- The "Renew membership" service tile. Its own description promises "Pay
-- online and download your updated certificate", which is the portal's job
-- now, so it goes to the member sign-in rather than to the renewal page that
-- explains the process.
UPDATE content_service_tiles
   SET href = 'https://membership.lcci.org.pk/member-login/'
 WHERE href = '/membership/renew';
