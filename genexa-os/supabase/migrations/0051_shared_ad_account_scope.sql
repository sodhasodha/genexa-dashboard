-- Two clinics can run in one ad account (Cleveland and Knoxville do). A clinic's
-- campaigns are then picked by name: campaign_name_contains keeps only campaigns
-- with that text, campaign_name_excludes drops campaigns with that text.
alter table client_campaign_scope add column campaign_name_excludes text;

-- Cleveland: only its own "… | Cleveland | …" campaigns. Its numbers can be trusted now.
update client_campaign_scope s
set campaign_name_contains = 'Cleveland', verified = true,
    note = 'Shares an ad account with Knoxville: only campaigns named "Cleveland" count here.'
from clients c where c.id = s.client_id and c.name = 'cleveland icp';

-- Knoxville: everything in the shared account except Cleveland's campaigns.
insert into client_campaign_scope (client_id, campaign_name_excludes, verified, note)
select c.id, 'Cleveland', true, 'Shares an ad account with Cleveland: campaigns named "Cleveland" are left out here.'
from clients c
where c.name = 'Dr Russell Smith Knoxville' and c.deleted_at is null
  and not exists (select 1 from client_campaign_scope s where s.client_id = c.id);

-- Per-ad rows carry no campaign name, so they cannot be split between two clinics
-- in one account. Per-ad rows already stored for these two are taken out of the ad rules.
update ad_metrics_ad_window w set ad_status = 'UNSCOPED'
from clients c
where c.id = w.client_id and c.name in ('cleveland icp', 'Dr Russell Smith Knoxville') and w.ad_status in ('ACTIVE', 'DISAPPROVED');
