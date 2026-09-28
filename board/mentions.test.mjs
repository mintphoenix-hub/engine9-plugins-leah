import { withHandles, parseMentions, findMentions, MENTION_PATTERN } from './mentions.js';
let pass=0,fail=0; const ck=(n,c,d='')=>{console.log(`  ${c?'ok  ':'FAIL'}  ${n}${d?' -> '+d:''}`);c?pass++:fail++;};
const people = withHandles([
  { id:'mary', displayName:'Mary-Anne Blake', firstName:'Mary' },
  { id:'jo',  displayName:'Jo Vance', firstName:'Joanna' },
  { id:'greta',  displayName:'Greta Hall', firstName:'Jody' },
  { id:'other',  displayName:'Someone Else', firstName:'Jody' },
  { id:'meg2',displayName:'Meg Carter', firstName:'Meg' },
  { id:'sam',   displayName:'Sam Okoro', firstName:null },
  { id:'alex',  name:'Alex Fontaine', firstName:null, isExternal:true },
]);
console.log('handles:');
ck('a first name is the handle', people.find(p=>p.id==='mary').handle==='Mary');
ck('a clash falls back to the display name', people.find(p=>p.id==='other').handle==='SomeoneElse');
ck('no first name squashes the display name', people.find(p=>p.id==='sam').handle==='SamOkoro');
ck('no first name gives the first word', people.find(p=>p.id==='alex').handle==='Alex');
console.log('\nmatching:');
ck('a plain mention', parseMentions('can @Mary bring it', people).join()==='mary');
ck('@Meg does not fire inside @Megan', parseMentions('@Megan said so', people).length===0);
ck('@Jody does not swallow @Joanna', parseMentions('@Joanna knows', people).join()==='jo');
ck('@Jody on its own', parseMentions('@Jody knows', people).join()==='greta');
ck('an email is not a mention', parseMentions('write to someone@example.com', people).length===0);
ck('case and accents fold', parseMentions('@MARY', people).join()==='mary');
ck('trailing punctuation still counts', parseMentions('thanks @Meg!', people).join()==='meg2');
ck('an external person can be named', parseMentions('ask @Alex about the run', people).join()==='alex');
ck('no @ at all is cheap and empty', parseMentions('nothing here', people).length===0);
console.log('\nhighlighting:');
const hits = findMentions('hi @Mary and @Joanna', people);
ck('two spans found', hits.length===2, JSON.stringify(hits.map(h=>h.handle)));
ck('spans line up with the text', 'hi @Mary and @Joanna'.slice(hits[0].start,hits[0].end)==='@Mary');
ck('the generic pattern finds an @word', [...('ping @somebody').matchAll(MENTION_PATTERN)].length===1);
ck('and ignores an email', [...('a@b.com').matchAll(MENTION_PATTERN)].length===0);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
