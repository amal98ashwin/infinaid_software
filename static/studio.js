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
  alert('Drag nodes from the library. Connect a right port to a left port. Select a loader to attach files. Run sends the recordings to the Python server on this PC. Click a completed node to review its results.');
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
    element('label','Recording sent to this PC’s Python server when you run',form);
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
function showResults(node) {
  const result=node?.output;
  if (!result) return toast('Run the workflow and select a completed node.');
  const dialog=$('#modal');
  dialog.replaceChildren();
  dialog.style.cssText='width:min(900px,90vw);max-height:85vh;overflow:auto';
  $('#modalBg').classList.add('show');
  element('h3',node.name,dialog);
  if (result.signal || result.features) {
    const signal=result.signal;
    const labels=result.features?Object.keys(result.features):signal.channels;
    const pick=element('select',undefined,dialog);
    labels.forEach(label=>element('option',label,pick));
    const plot=element('canvas',undefined,dialog);
    plot.width=800; plot.height=200; plot.style.width='100%';
    const times=result.times || signal.times;
    function draw() {
      const values=result.features?result.features[pick.value]:signal.values[pick.selectedIndex];
      const ctx=plot.getContext('2d');
      ctx.clearRect(0,0,800,200);
      const lo=values.reduce((a,b)=>Math.min(a,b),Infinity);
      const hi=values.reduce((a,b)=>Math.max(a,b),-Infinity);
      ctx.beginPath();ctx.strokeStyle='#087f73';
      values.forEach((v,i)=>{const x=10+780*i/Math.max(1,values.length-1),y=170-150*(v-lo)/(hi-lo||1); if(i)ctx.lineTo(x,y);else ctx.moveTo(x,y);});
      ctx.stroke();ctx.fillText(times[0].toFixed(2)+' s',10,194);ctx.fillText(times.at(-1).toFixed(2)+' s',735,194);
    }
    pick.onchange=draw;draw();
    if(signal) element('p',signal.samples+' samples per channel at '+signal.sfreq+' Hz. Flagged channels: '+(signal.bads.join(', ')||'none'),dialog);
  }
  if(result.components) {
    element('p','Select components to remove, then run the downstream removal node. Probabilities are ordered brain, muscle, eye, heart, line, channel, other.',dialog);
    for(const component of result.components) {
      const row=element('label',undefined,dialog); row.style.display='block';
      const check=element('input',undefined,row);check.type='checkbox';
      check.checked=(node.params.exclude??result.components.filter(c=>c.remove).map(c=>c.index)).includes(component.index);
      row.append(' IC '+component.index+' · '+component.label+' · '+component.probabilities.map(v=>(100*v).toFixed(1)+'%').join(' / '));
      check.onchange=()=>{node.params.exclude=[...dialog.querySelectorAll('input')].flatMap((c,i)=>c.checked?[i]:[]);render();};
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
    $('#runSummary').textContent='Processing on this PC…';
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
