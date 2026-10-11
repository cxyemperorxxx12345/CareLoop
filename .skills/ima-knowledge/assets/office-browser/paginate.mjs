// Browser only: retain the renderer's HTML and styles; paginate block flow.
// Not a Microsoft Word pagination engine. Oversized indivisible blocks remain
// visible and are reported, never silently cropped or deleted.
export async function paginateDocx(root) {
 await document.fonts.ready;
 await Promise.all([...root.querySelectorAll('img')].map(i=>i.decode?.().catch(()=>{})));
 const warnings=[];
 for (const original of [...root.querySelectorAll('section.docx')]) {
  const article=original.querySelector(':scope > article'); if(!article) continue;
  const css=getComputedStyle(original);
  const height=parseFloat(css.minHeight)||1122.52;
  if(!original.style.width)original.style.width='793.7px';
  if(!original.style.paddingTop)original.style.padding='72px';
  original.style.minHeight=height+'px';original.style.boxSizing='border-box';
  const queue=[...article.children];article.replaceChildren();
  let page=original,body=article;
  const next=()=>{const clone=original.cloneNode(true);clone.querySelector(':scope > article').replaceChildren();clone.querySelectorAll('[id]').forEach(x=>x.removeAttribute('id'));page.after(clone);page=clone;body=clone.querySelector(':scope > article');};
  const fits=()=>{const c=getComputedStyle(page);const foot=page.querySelector(':scope > footer');const bottom=page.getBoundingClientRect().top+height-parseFloat(c.paddingBottom)-(foot?.getBoundingClientRect().height||0);return !body.lastElementChild||body.lastElementChild.getBoundingClientRect().bottom<=bottom+1;};
  for(const block of queue){body.append(block);if(!fits()&&body.children.length>1){block.remove();next();body.append(block);}if(!fits()){warnings.push('存在单个超高内容块，保留完整显示；该页高度可能超过原纸张。');}}
 }
 return {pages:root.querySelectorAll('section.docx').length,warnings:[...new Set(warnings)]};
}
