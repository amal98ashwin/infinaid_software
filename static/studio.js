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
  const low=number('Y minimum',''), high=number('Y maximum','');
  low.placeholder=high.placeholder='Auto';
  const reset=button('Auto Y',controls,()=>{low.value=high.value='';refresh();});
  const status=element('small',undefined,parent);
  status.style.display='block';
  const viewport=element('div',undefined,parent);
  const rows=featureMode?4:8;
  const rowHeight=Math.max(featureMode?70:42,Math.min(featureMode?110:64,Math.floor(innerHeight*.52/rows)));
  viewport.style.cssText='overflow-y:auto;height:'+Math.min(rows,names.length)*rowHeight+'px;border:1px solid #cad6d4';
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
    const minY=low.valueAsNumber,maxY=high.valueAsNumber;
    if(!(duration>0)||(manual&&!(maxY>minY))){
      status.textContent='Enter a positive window and two ordered Y limits, or select Auto Y.';return;
    }
    pan.max=Math.max(first,last-duration);pan.disabled=Number(pan.max)<=first;
    const start=Number(pan.value),end=start+duration;
    const a=indexAt(start),b=end>=last?count:indexAt(end);
    const top=Math.floor(viewport.scrollTop/rowHeight);
    const stop=Math.min(names.length,top+rows+1);
    for(const i of decoded.keys())if(i<top||i>=stop)decoded.delete(i);
    status.textContent=start.toFixed(2)+' – '+end.toFixed(2)+' s'+(featureMode?' · Feature over time (left) · Distribution over the full recording (right)':' · Amplitude in node output units');
    spacer.replaceChildren();
    for(let i=top;i<stop;i++){
      const data=series(i), canvas=element('canvas',undefined,spacer);
      const w=viewport.clientWidth,h=rowHeight,dpr=window.devicePixelRatio||1;
      canvas.style.cssText='position:absolute;left:0;top:'+i*h+'px;width:100%;height:'+h+'px';
      canvas.width=w*dpr;canvas.height=h*dpr;canvas.setAttribute('aria-label',names[i]);
      const c=canvas.getContext('2d');c.scale(dpr,dpr);
      const left=55,right=featureMode?Math.floor(w*.67):w-12,yTop=17,yBottom=h-15;
      c.fillStyle=i%2?'#f4f8f8':'#fff';c.fillRect(0,0,w,h);
      c.fillStyle='#163c40';c.font='bold 11px sans-serif';c.fillText(names[i],6,12,right-6);
      const [lo,hi]=manual?[minY,maxY]:bounds(data,a,b);
      const y=v=>yBottom-(v-lo)/(hi-lo)*(yBottom-yTop);
      c.font='10px sans-serif';c.fillText(fmt(hi),2,yTop+6,left-5);c.fillText(fmt(lo),2,yBottom,left-5);
      for(let k=0;k<=4;k++){
        const x=left+(right-left)*k/4;
        c.fillStyle='#d8e3e3';c.fillRect(x,yTop,1,yBottom-yTop);
        c.fillStyle='#4b6668';c.textAlign='center';c.fillText(fmt(start+duration*k/4)+'s',x,h-3);c.textAlign='left';
      }
      c.save();c.beginPath();c.rect(left,yTop,right-left+1,yBottom-yTop+1);c.clip();
      c.strokeStyle='#067775';c.fillStyle=c.strokeStyle;c.beginPath();
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
        c.fillStyle='#457b9d';
        bins.forEach((n,k)=>{const bar=(yBottom-yTop)*n/peak;c.fillRect(x+k*width/24,yBottom-bar,Math.max(1,width/24-1),bar);});
        c.fillStyle='#4b6668';c.fillText(fmt(min),x,h-3);c.textAlign='right';c.fillText(fmt(max),w-5,h-3);
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
function showResults(node) {
  const result=node?.output;
  if (!result) return toast('Run the workflow and select a completed node.');
  const dialog=$('#modal');
  dialog.replaceChildren();
  dialog.style.cssText='width:min(900px,90vw);max-height:85vh;overflow:auto';
  $('#modalBg').classList.add('show');
  element('h3',node.name,dialog);
  if (result.signal) resultViewer(result,dialog,false);
  if (result.features) resultViewer(result,dialog,true);
  if(result.components) {
    element('p','Select components to remove, then run the downstream removal node. Probabilities are ordered brain, muscle, eye, heart, line, channel, other.',dialog);
    for(const component of result.components) {
      const row=element('label',undefined,dialog); row.style.display='block';
      const check=element('input',undefined,row);check.type='checkbox';
      check.checked=(node.params.exclude??result.components.filter(c=>c.remove).map(c=>c.index)).includes(component.index);
      row.append(' IC '+component.index+' · '+component.label+' · '+component.probabilities.map(v=>(100*v).toFixed(1)+'%').join(' / '));
      check.onchange=()=>{node.params.exclude=[...dialog.querySelectorAll('input[type=checkbox]')].flatMap((c,i)=>c.checked?[i]:[]);render();};
    }
    button('Use automatic threshold',dialog,()=>{delete node.params.exclude; render(); dialog.parentElement.classList.remove('show');});
  }
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
