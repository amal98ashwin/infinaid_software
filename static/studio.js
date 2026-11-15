const recordings = new Map();
const sessionKey = 'infinaid-python-workflow';
let defaults;
let busy = false;
const choices = {
  unit: ['µV', 'V'], parameter: ['Offset','Exponent'],
  mode: ['Common Average','Selected Channel'],
  method: ['Absolute Band Power','Relative Band Power']
};

function element(tag, text, parent) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  parent?.append(item);
  return item;
}
function button(text, parent, action) {
  const item = element('button', text, parent);
  item.className = 'btn';
  item.onclick = action;
  return item;
}
function select(id) { selected = id; render(); }
function showHelp() {
  alert('Drag nodes from the library. Connect a right port to a left port. Select a loader to attach files. Run sends the recordings to this Python server. Click a completed node to review its results.');
}
function inspector() {
  const node = nodes.find(item => item.id === selected);
  if (!node) return inspectorEmpty();
  const panel = $('#inspector');
  panel.replaceChildren();
  const form = element('div', undefined, panel);
  form.className = 'form';
  element('h3',node.name,form);
  if (node.name.startsWith('Load ')) {
    element('label','Recording sent to the Python server when you run',form);
    const picker = element('input',undefined,form);
    picker.type = 'file';
    picker.accept = '.' + node.name.split(' ')[1].toLowerCase();
    if (node.name === 'Load SET') {
      picker.multiple = true;
      picker.accept = '.set,.fdt';
      element('small','Select the .set and its .fdt together when stored separately.',form);
    }
    element('small',(recordings.get(node.id)||[]).map(f=>f.name).join(', '),form);
    picker.onchange = () => {recordings.set(node.id,[...picker.files]); inspector();};
    if (node.name === 'Load XDF') button('List XDF streams', form, async () => {
      try {
        const data = new FormData();
        const file = recordings.get(node.id)?.[0];
        if (!file) throw Error('Select an XDF file first.');
        data.append('file',file);
        const res = await fetch('/api/streams',{method:'POST',body:data});
        const result = await res.json();
        if (!res.ok) throw Error(result.error);
        element('pre',result.map(s=>s.index+'  '+s.name+'  '+s.type+'  '+s.sfreq+' Hz').join('\n'),form);
      } catch (error) { toast(error.message); }
    });
  }
  for (const [key,initial] of Object.entries(defaults[node.name])) {
    if (['filename','window','total_fmin','total_fmax'].includes(key)) continue;
    const field = element('div',undefined,form);
    field.className = 'field';
    const label = element('label',key.replaceAll('_',' '),field);
    let options = choices[key];
    if (node.name === 'Export Table') options = ['temporal','summary'];
    if (node.name === 'Bandpower Asymmetry' && key === 'method') options = ['Log Power Ratio','Normalized Asymmetry'];
    const input = element(options?'select':'input',undefined,field);
    if (options) options.forEach(value=>element('option',value,input));
    if (typeof initial === 'number') {input.type='number'; input.step='any';}
    input.id = 'param-'+key;
    label.htmlFor = input.id;
    const value = node.params[key] ?? initial;
    input.value = Array.isArray(value)?value.join(', '):value;
    input.onchange = () => {
      node.params[key] = Array.isArray(initial)?input.value.split(',').map(s=>s.trim()).filter(Boolean):
        typeof initial==='number'?Number(input.value):input.value;
      render();
    };
  }
  if (node.output) button('View node results',form,()=>showResults(node));
  button('Run to this node',form,()=>run(node.id));
  button('Delete node',form,()=>{
    nodes = nodes.filter(n=>n!==node);
    edges = edges.filter(e=>e.from!==node.id&&e.to!==node.id);
    recordings.delete(node.id);
    selected=null; render();
  });
}
function resultViewer(result, parent, featureMode) {
  const signal = result.signal;
  const names = featureMode ? Object.keys(result.features) : signal.channels;
  const times = featureMode ? result.times : null;
  const count = featureMode ? times.length : signal.samples;
  if (!names.length || !count) return element('p','No samples available.',parent);
  const first = featureMode ? Math.min(0,times[0]) : 0;
  const last = featureMode ? times.at(-1) : (count-1)/signal.sfreq;
  const controls = element('div',undefined,parent);
  controls.style.cssText='display:flex;gap:12px;align-items:end;flex-wrap:wrap;margin:10px 0';
  function number(labelText,value) {
    const label=element('label',labelText,controls);
    const input=element('input',undefined,label);
    input.type='number'; input.step='any'; input.value=value;
    input.style.cssText='display:block;width:90px;padding:4px';
    return input;
  }
  const windowSize=number('Window (s)',5);
  windowSize.min='0.000001';
  const low=number('Y minimum (µV)',''), high=number('Y maximum (µV)','');
  low.placeholder=high.placeholder='Auto';
  const reset=button('Auto Y',controls,()=>{low.value=high.value='';refresh();});
  const status=element('small',undefined,parent);
  status.style.display='block';
  const viewport=element('div',undefined,parent);
  const rows=featureMode?4:8;
  const rowHeight=Math.max(featureMode?70:42,Math.min(featureMode?110:64,Math.floor(innerHeight*.52/rows)));
  viewport.style.cssText='overflow-y:auto;height:'+Math.min(rows,names.length)*rowHeight+'px;border:1px solid #495460';
  const spacer=element('div',undefined,viewport);
  spacer.style.cssText='height:'+names.length*rowHeight+'px;position:relative';
  const label=element('label','Time position ',parent);
  label.style.cssText='display:flex;align-items:center;gap:8px;margin:10px 0';
  const pan=element('input',undefined,label);
  pan.type='range';pan.min=first;pan.step='any';pan.value=first;pan.style.flex='1';
  const decoded=new Map(), histograms=new Map();
  function series(i) {
    if(featureMode)return result.features[names[i]];
    if(!decoded.has(i)){
      const bytes=Uint8Array.from(atob(signal.rows[i]),c=>c.charCodeAt(0));
      decoded.set(i,new Float32Array(bytes.buffer));
    }
    return decoded.get(i);
  }
  function bounds(data,a,b){
    let min=Infinity,max=-Infinity;
    for(let j=a;j<b;j++)if(Number.isFinite(data[j])){min=Math.min(min,data[j]);max=Math.max(max,data[j]);}
    if(min===Infinity)return [0,1];
    if(min===max){const pad=Math.abs(min)*.05||1;return [min-pad,max+pad];}
    return [min,max];
  }
  function histogram(i,data){
    if(histograms.has(i))return histograms.get(i);
    const [min,max]=bounds(data,0,data.length),bins=Array(24).fill(0);
    for(const value of data)if(Number.isFinite(value))bins[Math.min(23,Math.floor(24*(value-min)/(max-min)))]++;
    const hist={min,max,bins};histograms.set(i,hist);return hist;
  }
  function indexAt(t){
    if(!featureMode)return Math.max(0,Math.min(count,Math.ceil(t*signal.sfreq)));
    let a=0,b=count;
    while(a<b){const m=Math.floor((a+b)/2);if(times[m]<t)a=m+1;else b=m;}
    return a;
  }
  const fmt=v=>Number(v.toPrecision(3)).toString();
  function refresh(){
    const duration=windowSize.valueAsNumber;
    const manual=low.value!==''||high.value!=='';
    const minY=low.valueAsNumber/1e6,maxY=high.valueAsNumber/1e6;
    if(!(duration>0)||(manual&&!(maxY>minY))){
      status.textContent='Enter a positive window and two ordered Y limits, or select Auto Y.';return;
    }
    pan.max=Math.max(first,last-duration);pan.disabled=Number(pan.max)<=first;
    const start=Number(pan.value),end=start+duration;
    const a=indexAt(start),b=end>=last?count:indexAt(end);
    const top=Math.floor(viewport.scrollTop/rowHeight);
    const stop=Math.min(names.length,top+rows+1);
    for(const i of decoded.keys())if(i<top||i>=stop)decoded.delete(i);
    status.textContent=start.toFixed(2)+' – '+end.toFixed(2)+' s'+(featureMode?' · Feature over time (left) · Distribution over the full recording (right)':' · Scale bars in µV');
    spacer.replaceChildren();
    for(let i=top;i<stop;i++){
      const data=series(i), canvas=element('canvas',undefined,spacer);
      const w=viewport.clientWidth,h=rowHeight,dpr=window.devicePixelRatio||1;
      canvas.style.cssText='position:absolute;left:0;top:'+i*h+'px;width:100%;height:'+h+'px';
      canvas.width=w*dpr;canvas.height=h*dpr;canvas.setAttribute('aria-label',names[i]);
      const c=canvas.getContext('2d');c.scale(dpr,dpr);
      const left=55,right=featureMode?Math.floor(w*.67):w-12,yTop=17,yBottom=h-15;
      c.fillStyle=i%2?'#2e353e':'#293039';c.fillRect(0,0,w,h);
      c.fillStyle='#e6edf4';c.font='bold 11px sans-serif';c.fillText(names[i],6,12,right-6);
      const [lo,hi]=manual?[minY,maxY]:bounds(data,a,b);
      const y=v=>yBottom-(v-lo)/(hi-lo)*(yBottom-yTop);
      c.font='10px sans-serif';
      if(!featureMode){
        c.strokeStyle='#b4c2d0';c.beginPath();c.moveTo(right-7,yTop);c.lineTo(right-7,yBottom);c.stroke();
        c.textAlign='right';c.fillStyle='#e6edf4';c.fillText(fmt((hi-lo)*1e6)+' µV',right-14,12);c.textAlign='left';
      }
      for(let k=0;k<=4;k++){
        const x=left+(right-left)*k/4;
        c.fillStyle='#46515e';c.fillRect(x,yTop,1,yBottom-yTop);
        c.fillStyle='#b4c2d0';c.textAlign='center';c.fillText(fmt(start+duration*k/4)+'s',x,h-3);c.textAlign='left';
      }
      c.save();c.beginPath();c.rect(left,yTop,right-left+1,yBottom-yTop+1);c.clip();
      c.strokeStyle='#85e4cc';c.fillStyle=c.strokeStyle;c.beginPath();
      let connected=false;
      for(let j=a;j<b;j++){
        const v=data[j];if(!Number.isFinite(v)){connected=false;continue;}
        const t=featureMode?times[j]:j/signal.sfreq,x=left+(t-start)/duration*(right-left);
        if(connected)c.lineTo(x,y(v));else c.moveTo(x,y(v));
        if(featureMode||!connected)c.fillRect(x-1,y(v)-1,3,3);
        connected=true;
      }
      c.stroke();c.restore();
      if(featureMode){
        const {min,max,bins}=histogram(i,data),x=right+24,width=w-x-10,peak=Math.max(1,...bins);
        c.fillStyle='#8bbdf0';
        bins.forEach((n,k)=>{const bar=(yBottom-yTop)*n/peak;c.fillRect(x+k*width/24,yBottom-bar,Math.max(1,width/24-1),bar);});
        c.fillStyle='#b4c2d0';c.fillText(fmt(min),x,h-3);c.textAlign='right';c.fillText(fmt(max),w-5,h-3);
        c.fillText('Count · max '+Math.max(...bins),w-6,12);
      }
    }
  }
  viewport.onscroll=pan.oninput=windowSize.onchange=low.onchange=high.onchange=refresh;
  viewport.addEventListener('wheel',e=>{
    if(!(e.shiftKey||Math.abs(e.deltaX)>Math.abs(e.deltaY))||pan.disabled)return;
    e.preventDefault();pan.value=Number(pan.value)+(e.deltaX||e.deltaY)*windowSize.valueAsNumber/Math.max(1,viewport.clientWidth);refresh();
  },{passive:false});
  refresh();
}
function scalpMap(parent, positions, values, limits, title) {
  parent.replaceChildren();
  const valid=positions.flatMap((p,i)=>p && Number.isFinite(values[i]) ? [{p,v:values[i]}] : []);
  if(valid.length<3){element('p','Scalp map requires at least three channels with known electrode positions.',parent);return;}
  const canvas=element('canvas',undefined,parent);
  canvas.width=600;canvas.height=530;canvas.style.cssText='width:100%;max-width:650px;display:block;margin:auto';
  const c=canvas.getContext('2d'),cx=300,cy=250,r=195;
  const [lo,hi]=limits,range=hi-lo||1;
  function color(v){
    const t=Math.max(0,Math.min(1,(v-lo)/range));
    const a=t<.5?[72,134,220]:[236,239,231],b=t<.5?[236,239,231]:[229,97,93],f=t<.5?t*2:(t-.5)*2;
    return 'rgb('+a.map((n,i)=>Math.round(n+(b[i]-n)*f)).join(',')+')';
  }
  c.save();c.beginPath();c.arc(cx,cy,r,0,2*Math.PI);c.clip();
  for(let y=-r;y<r;y+=4)for(let x=-r;x<r;x+=4){
    let total=0,weight=0;
    for(const {p,v} of valid){
      const d=(x/r-p[0])**2+(-y/r-p[1])**2,w=1/Math.max(d,1e-6);
      total+=w*v;weight+=w;
    }
    c.fillStyle=color(total/weight);c.fillRect(cx+x,cy+y,4,4);
  }
  c.restore();c.strokeStyle='#bdcbd5';c.lineWidth=2;c.beginPath();c.arc(cx,cy,r,0,2*Math.PI);
  c.moveTo(cx-17,cy-r+1);c.lineTo(cx,cy-r-26);c.lineTo(cx+17,cy-r+1);c.stroke();
  for(const {p} of valid){c.fillStyle='#162b36';c.beginPath();c.arc(cx+r*p[0],cy-r*p[1],3,0,7);c.fill();}
  c.fillStyle='#e6edf4';c.font='15px sans-serif';c.textAlign='center';c.fillText(title,cx,20);
  c.fillText('Left',45,cy);c.fillText('Right',555,cy);
  for(let x=0;x<300;x++){c.fillStyle=color(lo+range*x/299);c.fillRect(150+x,475,1,12);}
  c.fillStyle='#d6e1eb';c.font='12px sans-serif';c.fillText(lo.toPrecision(3),150,508);c.fillText(hi.toPrecision(3),450,508);
}
function featureMaps(result,parent) {
  const labels=Object.keys(result.features),data=Object.values(result.features);
  const holder=element('div',undefined,parent);
  const control=element('label','Time ',parent),slider=element('input',undefined,control),time=element('output',undefined,control);
  control.style.cssText='display:flex;gap:12px;align-items:center';
  slider.type='range';slider.min=0;slider.max=Math.max(0,result.times.length-1);slider.step=1;slider.value=0;slider.style.flex='1';
  let lo=Infinity,hi=-Infinity;
  data.forEach(row=>row.forEach(v=>{if(Number.isFinite(v)){lo=Math.min(lo,v);hi=Math.max(hi,v);}}));
  if(lo===hi){lo-=1;hi+=1;}
  function draw(){
    const i=Number(slider.value);time.value=Number(result.times[i]||0).toFixed(2)+' s';
    scalpMap(holder,result.positions||[],data.map(row=>row[i]),[lo,hi],'Feature across electrodes');
  }
  slider.oninput=draw;draw();
  element('p','Scalp colors use a fixed scale across time. Interpolation estimates values between electrodes.',parent);
  const list=element('div',undefined,parent);list.style.cssText='height:400px;overflow-y:auto';
  labels.forEach((name,i)=>{
    const row=element('div',undefined,list);row.style.cssText='height:100px;border-top:1px solid #46515e;padding:6px';
    element('small',name,row);
    const canvas=element('canvas',undefined,row);canvas.width=800;canvas.height=70;canvas.style.cssText='width:100%;height:70px';
    const c=canvas.getContext('2d'),finite=data[i].filter(Number.isFinite);
    if(!finite.length){c.fillStyle='#d6e1eb';c.fillText('No finite values',10,30);return;}
    let a=Infinity,b=-Infinity;finite.forEach(v=>{a=Math.min(a,v);b=Math.max(b,v);});
    const bins=Array(32).fill(0);finite.forEach(v=>bins[Math.min(31,Math.floor((v-a)/(b-a||1)*32))]++);
    const peak=Math.max(...bins);c.fillStyle='#8bbdf0';
    bins.forEach((n,k)=>c.fillRect(45+k*22,48-n/peak*40,20,n/peak*40));
    c.fillStyle='#d6e1eb';c.font='12px sans-serif';c.fillText(a.toPrecision(3),45,65);c.fillText(b.toPrecision(3),710,65);c.fillText('Count',0,12);c.fillText(String(peak),0,28);
  });
}
function icaResults(node,parent){
  const result=node.output,selection=element('select',undefined,parent);
  result.components.forEach(c=>{element('option','IC '+c.index,selection).value=c.index;});
  const map=element('div',undefined,parent);
  function draw(){
    const values=result.ica_maps?.[Number(selection.value)]||[];
    const peak=values.reduce((a,v)=>Math.max(a,Math.abs(v)),0)||1;
    scalpMap(map,result.ica_positions||[],values,[-peak,peak],'IC '+selection.value+' · component weights');
  }
  selection.onchange=draw;draw();
  element('p','Select components to remove, then run the downstream removal node.',parent);
  const wrap=element('div',undefined,parent);wrap.style.overflowX='auto';
  const table=element('table',undefined,wrap);table.className='preview-table';
  const head=element('tr',undefined,element('thead',undefined,table));
  ['Remove','Component','ICLabel','Brain','Muscle','Eye','Heart','Line noise','Channel noise','Other'].forEach(t=>element('th',t,head));
  const body=element('tbody',undefined,table),checks=[];
  for(const component of result.components){
    const row=element('tr',undefined,body),cell=element('td',undefined,row),check=element('input',undefined,cell);
    check.type='checkbox';check.checked=(node.params.exclude??result.components.filter(c=>c.remove).map(c=>c.index)).includes(component.index);
    checks.push({check,index:component.index});
    element('td','IC '+component.index,row);element('td',component.label,row);
    component.probabilities.forEach(v=>element('td',(100*v).toFixed(1)+'%',row));
    check.onchange=()=>{node.params.exclude=checks.filter(c=>c.check.checked).map(c=>c.index);render();};
    row.onclick=e=>{if(e.target!==check){selection.value=component.index;draw();}};
  }
  button('Use automatic threshold',parent,()=>{delete node.params.exclude;render();showResults(node);});
}

function showResults(node) {
  const result=node?.output;
  if (!result) return toast('Run the workflow and select a completed node.');
  const dialog=$('#modal');
  dialog.replaceChildren();
  dialog.style.cssText='width:min(900px,90vw);max-height:85vh;overflow:auto';
  $('#modalBg').classList.add('show');
  element('h3',node.name,dialog);
  if (result.signal && !result.components) resultViewer(result,dialog,false);
  if (result.features) featureMaps(result,dialog);
  if(result.components) icaResults(node,dialog);
  if(result.r!==undefined)element('p','Pearson r = '+result.r,dialog);
  button('Close',dialog,()=>$('#modalBg').classList.remove('show'));
}
function graph() {
  return {nodes:nodes.map(({id,name,x,y,params})=>({id,name,x,y,params})),edges};
}
function restore(data) {
  if(!Array.isArray(data.nodes)||!Array.isArray(data.edges)||data.nodes.length>100)throw Error('Invalid workflow');
  const ids=new Set();
  for(const n of data.nodes){
    if(!Object.hasOwn(defaults,n.name)||!/^n\d+$/.test(n.id)||ids.has(n.id)||!Number.isFinite(n.x)||!Number.isFinite(n.y))throw Error('Invalid workflow node');
    ids.add(n.id);n.params={...defaults[n.name],...n.params};n.status='idle';delete n.output;
    if(n.name==='Export Table'&&!['summary','temporal'].includes(n.params.mode))n.params.mode='temporal';
    if(n.name==='Channel Selector'&&typeof n.params.channels==='string')n.params.channels=n.params.channels.split(',').map(s=>s.trim()).filter(Boolean);
  }
  if(data.edges.some(e=>!ids.has(e.from)||!ids.has(e.to)))throw Error('Invalid connection');
  nodes=data.nodes;edges=data.edges;seq=Math.max(0,...nodes.map(n=>Number(n.id.slice(1))))+1;
  recordings.clear();selected=null;render();
}
function saveFile(name,blob){
  const url=URL.createObjectURL(blob), link=document.createElement('a');
  link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
async function run(target){
  if(busy)return;
  busy=true;$('#runBtn').disabled=true;
  try {
    const g=graph();
    if(target){
      const required=new Set();
      function upstream(id){if(required.has(id))return;required.add(id);edges.filter(e=>e.to===id).forEach(e=>upstream(e.from));}
      upstream(target);g.nodes=g.nodes.filter(n=>required.has(n.id));g.edges=g.edges.filter(e=>required.has(e.to));
    }
    const data=new FormData();
    for(const n of g.nodes){
      if(n.name.startsWith('Load ')&&!recordings.get(n.id)?.length)throw Error('Select the recording for '+n.name+' ('+n.id+').');
      for(const file of recordings.get(n.id)||[])data.append(n.id,file);
    }
    data.append('graph',JSON.stringify(g));
    $('#runSummary').textContent='Processing on the Python server…';
    nodes.forEach(n=>{delete n.output;n.status='idle';}); render();
    const res=await fetch('/api/run',{method:'POST',body:data});
    const response=await res.json();
    if(!res.ok)throw Error(response.error);
    for(const n of nodes)if(response.results[n.id]){n.output=response.results[n.id];n.status='done';}
    const logPanel=$('#log');logPanel.replaceChildren();
    for(const file of response.downloads){
      const bytes=Uint8Array.from(atob(file.data),c=>c.charCodeAt(0));
      button('Download '+file.name,logPanel,()=>saveFile(file.name,new Blob([bytes])));
    }
    $('#runSummary').textContent='Completed '+g.nodes.length+' steps. Select a node to inspect its results.';
    render();
  } catch(error){$('#runSummary').textContent=error.message;} finally{busy=false;$('#runBtn').disabled=false;}
}
async function start(){
  defaults=await (await fetch('/defaults.json')).json();
  for(const [name,p] of Object.entries(defaults)){specs[name].coming=false;specs[name].params=p;}
  groups();$('#nodeSearch').oninput=groups;
  $('#newBtn').onclick=()=>{if(confirm('Clear this workflow?'))restore({nodes:[],edges:[]});};
  $('#runBtn').onclick=()=>run();
  $('#dataTab').onclick=()=>showResults(nodes.find(n=>n.id===selected)||nodes.findLast(n=>n.output));
  $('#clearLog').onclick=()=>$('#log').replaceChildren();
  $('#sampleBtn').textContent='Add CSV pipeline';
  $('#sampleBtn').onclick=()=>{const a=addNode('Load CSV',40,100), b=addNode('Bandpass Filter',290,100), c=addNode('Power Feature Extraction',540,100);connect(a.id,b.id);connect(b.id,c.id);select(a.id);};
  $('#exportWorkflow').textContent='Workflow file';
  $('#exportWorkflow').onclick=()=>{
    const d=$('#modal');d.replaceChildren();$('#modalBg').classList.add('show');
    button('Download workflow JSON',d,()=>saveFile('eeg-workflow.json',new Blob([JSON.stringify(graph(),null,2)])));
    const input=element('input',undefined,d); input.type='file';input.accept='.json';
    input.onchange=async()=>{try{restore(JSON.parse(await input.files[0].text()));$('#modalBg').classList.remove('show');}catch(e){toast(e.message);}};
    button('Close',d,()=>$('#modalBg').classList.remove('show'));
  };
  function scale(value){zoom=Math.min(1.5,Math.max(.4,value));board.style.transform='scale('+zoom+')';board.style.transformOrigin='top left';$('#zoomLabel').textContent=Math.round(100*zoom)+'%';}
  $('#zoomIn').onclick=()=>scale(zoom+.1);$('#zoomOut').onclick=()=>scale(zoom-.1);
  $('#fitBtn').onclick=()=>scale(($('#canvas').clientWidth-20)/Math.max(1,...nodes.map(n=>n.x+200)));
  try{restore(JSON.parse(localStorage.getItem(sessionKey))||{nodes:[],edges:[]});}catch{restore({nodes:[],edges:[]});}
  $('#runSummary').textContent='Select a recording and run the connected workflow.';
}
start();
