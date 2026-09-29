export const settings = [
  {
    name: 'model',
    type: 'string',
    default: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    label: 'Model',
    description: 'A Cloudflare Workers AI text model. Larger models write better and use more of the free daily allowance.'
  },
  {
    name: 'daily_limit',
    type: 'int',
    default: 150,
    min: 1,
    max: 2000,
    label: 'Most requests per day',
    description: 'Keeps use inside the free daily allowance. Once it is reached the helper says to try again tomorrow. Counted per UTC day.'
  },
  {
    name: 'max_input_chars',
    type: 'int',
    default: 9000,
    min: 500,
    max: 30000,
    hidden: true,
    label: 'Most characters sent at once',
    description: 'Longer text is refused with a message asking for one section at a time.'
  }
];
export default { settings };
