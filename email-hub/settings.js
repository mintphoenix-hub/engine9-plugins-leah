export const settings = [
  {
    name: 'provider',
    type: 'string',
    default: 'kit',
    values: ['kit', 'mailchimp'],
    label: 'Email provider',
    description: 'Which service sends the emails and holds the list. The hub reads and writes it through that provider\'s adapter; API keys are the host\'s secrets, never settings.'
  },
  {
    name: 'list_id',
    type: 'string',
    default: '',
    label: 'Audience id',
    description: 'For providers that split a account into audiences (Mailchimp: the list id). Ignored by Kit, which has one list.'
  },
  {
    name: 'from_name',
    type: 'string',
    default: '',
    label: 'From name',
    description: 'For providers that take it per email (Mailchimp). Kit uses the sending address set in Kit.'
  },
  {
    name: 'reply_to',
    type: 'string',
    default: '',
    label: 'Reply-to address',
    description: 'For providers that take it per email (Mailchimp).'
  },
  {
    name: 'unsubscribe_page_url',
    type: 'string',
    default: '',
    label: 'Unsubscribe page on your website',
    description: 'Where "Unsubscribe" in every email goes, e.g. https://example.org/#/unsubscribe. The recipient\'s address is added for you. Leave empty to use the provider\'s own page. The provider\'s link stays in the footer as a fallback either way.'
  }
];
export default { settings };
