// One accepted snapshot per active task; capture ticket BEFORE each request.
export function taskStateGate() {
 let epoch=0, id=null, current=null;
 const terminal=s=>['succeeded','failed'].includes(s);
 return {
  select(nextId) { epoch++;id=nextId;current=null;return epoch; },
  ticket() { return epoch; },
  invalidate() { epoch++; },
  accept(ticket,next) {
   if(ticket!==epoch||!next||next.id!==id)return null;
   if(current && terminal(current.state) && next.state!==current.state)return null;
   if(current?.state==='processing' && ['submitting','submitted'].includes(next.state))return null;
   current=next;return next;
  }
 };
}
