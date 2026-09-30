/*
  The contract between the hub and an email service.

  The hub (routes.js and the browser UI) knows nothing about Mailchimp or Kit. A provider is a plain object that
  turns one service's API into the calls below, in plain data, and throws a HubError with a sentence a person can be
  shown when something goes wrong. It gets its key and `fetch` from the host; nothing here reads a secret.

  Required:
    label                       'Mailchimp'
    mergeTags                   { address, unsubscribe }   what the service replaces in the footer
    connected()                 boolean
    appUrl(path)                a link into the service's own website, for "Open in ..."
    listCampaigns()             { campaigns: [Campaign], dc? }
    getCampaign(id)             Campaign, freshly read
    campaignContent(id)         { html, template? }   template: the name of the service-side template the email is sent in, when it has one
    createCampaign(input)       Campaign      input: { subject, previewText, title, html, to: { tagId?, segmentId? } }
    updateCampaign(id, fields)  Campaign      fields: { subject?, previewText?, title? }
    deleteCampaign(id)          {}
    duplicateCampaign(id)       Campaign
    schedule(id, isoUtc)        {}            the hub has already checked the rules
    unschedule(id)              {}
    audience()                  { list, subscribers, tags: [{id,name,count}], segments: [{id,name,count}] }
    counts()                    { subscribed, unsubscribed, cleaned, pending }
    growth(days, now)           { added, unsubscribed }
  Optional (declare it in `capabilities`, or the screen hides it):
    sendChecklist(id)           { ready, problems: [{heading, details}] }
    sendTest(id, emails)        { sentTo }
    campaignReport(id)          { recipients, opened, openRate, clicked, clickRate, unsubscribed, bounced }
    listContacts(query)         { contacts: [Contact], total, next }  query: { status, tag, email, after }
    contact(id) / addContact(input) / tagContact(id, name, active) / unsubscribeContact(id)
    createTag(name)             { tag }
    fields()                    { fields: [{ tag, name, type, required }] }
    listTemplates()             { templates: [{ id, name, isDefault }] }   the service's own templates, listed by name (read only)
    importContacts(input)       { count, invalid }   input: { people, tag, agreed }
    editUrl(campaign)           a link to design the email in the service

  Campaign: { id, status: 'save'|'paused'|'schedule'|'sending'|'sent', subject, title, preview, audience, segment,
              recipients, created, when, sent, openRate, clickRate, stats: { opened, clicked }, archiveUrl, editUrl }
  Contact:  { id, email, first, last, state: 'subscribed'|'unsubscribed'|'cleaned'|'pending', created, tags: [{id,name}], source }
*/

/* An error whose message can be shown as it is. `http` is the status to answer with. */
export class HubError extends Error {
  constructor(message, http = 400) { super(message); this.name = 'HubError'; this.http = http; }
}

export const CAPABILITIES = ['checklist', 'test', 'report', 'contacts', 'tags', 'segments', 'fields', 'import', 'editDesign', 'templates', 'look'];

const REQUIRED = ['connected', 'appUrl', 'listCampaigns', 'getCampaign', 'campaignContent', 'createCampaign', 'updateCampaign', 'deleteCampaign', 'duplicateCampaign', 'schedule', 'unschedule', 'audience', 'counts', 'growth'];

/* Throws if the provider is missing something the hub always needs. Optional calls are checked by capability. */
export function assertProvider(p) {
  if (!p || typeof p !== 'object') throw new Error('email-hub: a provider is required');
  if (!p.label) throw new Error('email-hub: the provider needs a label');
  if (!p.mergeTags?.address || !p.mergeTags?.unsubscribe) throw new Error('email-hub: the provider needs mergeTags.address and mergeTags.unsubscribe');
  const missing = REQUIRED.filter((k) => typeof p[k] !== 'function');
  if (missing.length) throw new Error(`email-hub: the provider is missing ${missing.join(', ')}`);
  return p;
}

/* What the provider can do beyond the basics, from the optional calls it has and any it turns off. */
export function capabilitiesOf(p) {
  const has = (...k) => k.every((x) => typeof p[x] === 'function');
  const c = {
    checklist: has('sendChecklist'), test: has('sendTest'), report: has('campaignReport'),
    contacts: has('listContacts', 'contact'), tags: has('createTag', 'tagContact'), segments: true, fields: has('fields'),
    import: has('importContacts'), editDesign: has('editUrl'), templates: has('listTemplates'), look: true, layouts: false
  };
  return { ...c, ...(p.capabilities || {}) };
}
