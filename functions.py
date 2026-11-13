import os, csv
import numpy as np, mne
from scipy.signal import butter, sosfiltfilt, welch
from scipy.integrate import trapezoid
from mne.preprocessing import ICA
from mne_icalabel import label_components
from mne_icalabel.iclabel.label_components import iclabel_label_components
import pyxdf
import openpyxl

FEATURE_NODE_NAMES = {
    "Power Feature Extraction", "Periodic Band Power", "Aperiodic 1/f",
    "Band Cordance", "Bandpower Asymmetry"
}

def create_eeg_raw(data,ch_names,sfreq,ch_types=None):
    data=np.asarray(data,float)
    if data.ndim!=2: raise ValueError("EEG data must be channels × samples.")
    if len(ch_names)!=data.shape[0]: raise ValueError(f"Number of channel names ({len(ch_names)}) does not match data channels ({data.shape[0]}).")
    sfreq=float(sfreq)
    if sfreq<=0: raise ValueError("Sampling rate must be greater than zero.")
    ch_names=[str(x).strip() for x in ch_names]
    if any(not x for x in ch_names): raise ValueError("Channel names cannot be empty.")
    if len(set(ch_names))!=len(ch_names): raise ValueError("Duplicate channel names found.")
    if ch_types is None: ch_types=["eeg"]*len(ch_names)
    info=mne.create_info(ch_names=ch_names,sfreq=sfreq,ch_types=ch_types)
    return apply_default_montage(mne.io.RawArray(data,info))


def load_xlsx_eeg(filepath,sfreq,unit="µV"):
    if not filepath or not os.path.isfile(filepath): raise FileNotFoundError("XLSX file not found.")
    wb=openpyxl.load_workbook(filepath,read_only=True,data_only=True); ws=wb.active; rows=list(ws.iter_rows(values_only=True))
    if not rows: raise ValueError("The XLSX file is empty.")
    headers=[str(x).strip() if x is not None else "" for x in rows[0]]
    if not headers: raise ValueError("No columns found in XLSX file.")
    timestamp_index=next((i for i,h in enumerate(headers) if h.lower() in ("timestamp","timestamps","time")),None)
    channel_indices=[i for i,h in enumerate(headers) if h and i!=timestamp_index]
    if not channel_indices: raise ValueError("No EEG channel columns found.")
    ch_names=[headers[i] for i in channel_indices]; values=[]
    for row in rows[1:]:
        if not row: continue
        try:
            current=[float(row[i]) for i in channel_indices]
            if current and all(np.isfinite(current)): values.append(current)
        except (TypeError,ValueError,IndexError): continue
    if not values: raise ValueError("No numeric EEG samples found in XLSX file.")
    data=np.asarray(values,float).T
    unit=str(unit).strip().lower()
    if unit in ("uv","µv","microvolt","microvolts"): data*=1e-6
    elif unit not in ("v","volt","volts"): raise ValueError("Unit must be V or µV.")
    return create_eeg_raw(data,ch_names,sfreq)

def get_xdf_streams(filepath):
    if not filepath or not os.path.isfile(filepath): raise FileNotFoundError("XDF file not found.")
    streams,header=pyxdf.load_xdf(filepath)
    if not streams: raise ValueError("No streams found in XDF file.")
    result=[]
    for i,s in enumerate(streams):
        info=s.get("info",{}); name=info.get("name",[""])[0]; stype=info.get("type",[""])[0]
        sfreq=info.get("nominal_srate",[""])[0]; channels=info.get("channel_count",[""])[0]
        result.append({"index":i,"name":str(name),"type":str(stype),"sfreq":float(sfreq) if sfreq not in ("",None) else 0,"channel_count":int(channels) if channels not in ("",None) else 0})
    return streams,result


def load_xdf_eeg(filepath,stream_index,sfreq=None,unit="V"):
    streams,_=get_xdf_streams(filepath); stream_index=int(stream_index)
    if stream_index<0 or stream_index>=len(streams): raise ValueError("Invalid XDF stream selection.")
    stream=streams[stream_index]; data=np.asarray(stream["time_series"],float)
    if data.ndim!=2: raise ValueError("Selected XDF stream does not contain 2D EEG data.")
    if data.shape[0]>data.shape[1]: data=data.T
    info=stream["info"]; ch_names=[]
    try:
        ch_list=info.get("desc",[])[0]["channels"][0]["channel"]
        ch_names=[str(ch.get("label",[f"EEG{i+1}"])[0]) for i,ch in enumerate(ch_list)]
    except Exception: pass
    if len(ch_names)!=data.shape[0]: ch_names=[f"EEG{i+1}" for i in range(data.shape[0])]
    if sfreq is None or float(sfreq)<=0: sfreq=float(info.get("nominal_srate",["0"])[0])
    if sfreq<=0: raise ValueError("Sampling rate is not available. Please enter it manually.")
    unit=str(unit).strip().lower()
    if unit in ("uv","µv","microvolt","microvolts"): data*=1e-6
    elif unit not in ("v","volt","volts"): raise ValueError("Unit must be V or µV.")
    return create_eeg_raw(data,ch_names,sfreq)

def load_set(f):
    if not f or not os.path.isfile(f): raise FileNotFoundError("SET file not found.")
    raw=mne.io.read_raw_eeglab(f, preload=True)
    return ensure_volts(raw)

def ensure_volts(raw):
    data = raw.get_data()

    # MNE EEG should be stored in volts.
    # If values look like typical EEG amplitudes expressed in µV,
    # convert them to volts.
    max_abs = np.nanmax(np.abs(data))

    if max_abs > 1e-3:
        print(f"Detected large EEG values ({max_abs:.6g}); converting µV → V.")
        raw._data *= 1e-6
    else:
        print(f"EEG values already appear to be in volts (max={max_abs:.6g}).")

    return raw

def _band(raw, lo, hi):
    lo, hi, ny = float(lo), float(hi), raw.info["sfreq"] / 2
    if lo <= 0 or hi <= lo: raise ValueError("Invalid frequency band.")
    if hi >= ny: raise ValueError(f"Upper frequency must be below Nyquist ({ny:.2f} Hz).")
    return lo, hi


def _win(raw, size, overlap):
    size, overlap = float(size), float(overlap)
    if size <= 0: raise ValueError("Window size must be greater than zero.")
    if not 0 <= overlap < 100: raise ValueError("Overlap must be between 0 and 100 percent.")
    n = max(1, int(size * raw.info["sfreq"]))
    return n, max(1, int(n * (1 - overlap / 100)))


def _times(raw, size, overlap, count):
    n, step = _win(raw, size, overlap); n = min(n, raw.n_times)
    return (np.arange(count) * step + n / 2) / raw.info["sfreq"]


def _spectral_windows(raw, size=2, overlap=50):
    x, fs = raw.get_data(), raw.info["sfreq"]; n, step = _win(raw, size, overlap)
    if x.shape[1] < n: return x[:, None, :], fs
    return np.asarray([x[:, i:i+n] for i in range(0, x.shape[1]-n+1, step)]).transpose(1, 0, 2), fs


def _bandpower(x, fs, lo, hi):
    f, p = welch(x, fs=fs, axis=-1, nperseg=min(x.shape[-1], 4096))
    m = (f >= lo) & (f <= hi)
    if not m.any(): raise ValueError("No frequency bins fall inside the requested band.")
    return trapezoid(p[..., m], f[m], axis=-1)


def bandpass(raw, low, high, order=4):
    low, high = _band(raw, low, high)
    sos = butter(order, [low, high], btype="bandpass", fs=raw.info["sfreq"], output="sos")
    out = raw.copy(); out._data = sosfiltfilt(sos, out.get_data(), axis=1); return out


def zscore(raw):
    out = raw.copy(); x = out.get_data(); s = x.std(1, keepdims=True); s[s == 0] = 1
    out._data = (x - x.mean(1, keepdims=True)) / s; return out


def crop(raw, start, stop):
    start, stop = float(start), float(stop)
    if start < 0 or stop <= start: raise ValueError("Invalid crop timing.")
    if stop > raw.times[-1]: raise ValueError("Crop stop time exceeds signal duration.")
    return raw.copy().crop(tmin=start, tmax=stop)


def resample(raw, sfreq):
    sfreq = float(sfreq)
    if sfreq <= 0: raise ValueError("Sampling frequency must be positive.")
    return raw.copy().resample(sfreq)


def rereference(raw,mode,channel=""):
    mode=str(mode).strip().lower()
    mode={"common average":"average","average reference":"average","selected channel":"channel","single channel":"channel"}.get(mode,mode)
    if mode=="average":
        out=raw.copy().set_eeg_reference("average",projection=False)
    elif mode=="channel":
        if not channel: raise ValueError("A reference channel must be selected.")
        if channel not in raw.ch_names: raise ValueError(f"Reference channel '{channel}' not found.")
        out=raw.copy().set_eeg_reference([channel],projection=False)
    else:
        raise ValueError("Unknown re-reference mode.")
    return out[0] if isinstance(out,tuple) else out


def save_set(raw, f):
    if raw is None: raise RuntimeError("No signal available to save.")
    if not f: raise ValueError("No output file selected.")
    if not f.lower().endswith(".set"): f += ".set"
    os.makedirs(os.path.dirname(os.path.abspath(f)), exist_ok=True)
    mne.export.export_raw(f, raw, fmt="eeglab", overwrite=True)
    return f


def channel_selector(raw, channels):
    channels = list(channels or [])
    if not channels: raise ValueError("No channels selected.")
    missing = [c for c in channels if c not in raw.ch_names]
    if missing: raise ValueError(f"Channels not found: {', '.join(missing)}")
    return raw.copy().pick(channels)


def label_bad_channels(raw, percentile, minsd=1, maxsd=1000):
    if raw is None: raise RuntimeError("No input signal.")
    percentile=float(percentile)
    if not 0 < percentile < 100: raise ValueError("Percentile must be between 0 and 100.")

    minsd=float(minsd)*1e-14
    maxsd=float(maxsd)*1e-6

    std_dev=np.std(raw.get_data(),axis=1)
    med=np.median(std_dev)
    threshold=np.percentile(std_dev,percentile)
    deviation=np.abs(std_dev-med)

    bad=[c for c,d,x in zip(raw.ch_names,deviation,std_dev)
         if d>=threshold or x<minsd or x>maxsd]

    return {
        "bad_channels":bad,
        "rms":std_dev,
        "threshold":threshold,
        "low_limit":minsd,
        "high_limit":maxsd,
        "channel_names":list(raw.ch_names),
        "std_dev":std_dev,
        "criterion_values":deviation,
        "percentile":percentile,
        "percentile_value":threshold
    }


def _pack(raw, result, name, method, size, overlap, fmin=None, fmax=None, kind="", pair=None):
    out = {}
    for key, value in result.items():
        a = np.asarray(value, float)
        a = a.reshape(1, -1) if a.ndim == 1 else a
        if a.ndim != 2 or not a.size: continue
        for i, row in enumerate(a):
            if kind == "aperiodic": label = f"{name}_{key.title()}_{raw.ch_names[i]}"
            elif kind == "asymmetry":
                label = f"{name}_{pair[0]}-{pair[1]}"
            elif kind == "cordance": label = name
            else: label = f"{name}_{raw.ch_names[i]}"
            out[label] = row.ravel()
    if not out: raise ValueError("No feature data available.")
    n = min(map(len, out.values())); out = {k:v[:n] for k,v in out.items()}
    return {"features":out, "times":_times(raw,size,overlap,n), "channels":list(out),
            "fmin":float(1 if fmin is None else fmin),
            "fmax":float(raw.info["sfreq"]/2-1 if fmax is None else fmax),
            "method":str(method), "window_size":float(size), "overlap":float(overlap),
            "feature_name":str(name)}


def power_feature(raw, fmin, fmax, method="Absolute Band Power", window_size=2, overlap=50):
    fmin, fmax = _band(raw, fmin, fmax); x, fs = _spectral_windows(raw, window_size, overlap)
    p = _bandpower(x, fs, fmin, fmax); method = str(method).lower()
    if method in ("relative band power","relative power"):
        t = _bandpower(x, fs, 1, fs/2-.1); p /= np.where(t == 0, 1, t)
    elif method not in ("absolute band power","absolute power"): raise ValueError("Unknown power feature method.")
    return p


def periodic_band_power(raw, fmin, fmax, fit_fmin=1, fit_fmax=None, window_size=2, overlap=50, progress=None):
    fmin, fmax = _band(raw, fmin, fmax); fit_fmax = raw.info["sfreq"]/2-1 if fit_fmax is None else fit_fmax
    fit_fmin, fit_fmax = _band(raw, fit_fmin, fit_fmax); x, fs = _spectral_windows(raw, window_size, overlap)
    out = np.zeros((x.shape[0], x.shape[1]))
    for c in range(x.shape[0]):
        for w in range(x.shape[1]):
            f, p = welch(x[c,w], fs=fs, nperseg=min(x.shape[-1],4096)); m = (f>=fit_fmin)&(f<=fit_fmax)
            if m.sum() < 5: raise ValueError("Not enough frequency bins for periodic fitting.")
            xx, yy = np.log10(f[m]), np.log10(np.maximum(p[m], np.finfo(float).tiny))
            sl, ic = np.polyfit(xx, yy, 1); pm = (f[m]>=fmin)&(f[m]<=fmax)
            if not pm.any(): raise ValueError("No frequency bins inside periodic band.")
            out[c,w] = trapezoid(np.maximum(p[m]-10**(ic+sl*xx),0)[pm], f[m][pm])
        if progress: progress((c+1)/x.shape[0])
    return out


def _fit_aperiodic(f, p, lo, hi):
    m = (f>=lo)&(f<=hi)&np.isfinite(p)&(p>0)
    if m.sum() < 5: raise ValueError("Not enough valid frequency bins for aperiodic fitting.")
    x, y = np.log10(f[m]), np.log10(p[m]); sl, ic = np.polyfit(x,y,1)
    return ic, -sl


def aperiodic_feature(raw, fmin=1, fmax=None, window_size=2, overlap=50, progress=None):
    fmax = raw.info["sfreq"]/2-1 if fmax is None else fmax; fmin, fmax = _band(raw,fmin,fmax)
    x, fs = _spectral_windows(raw,window_size,overlap); nc,nw = x.shape[:2]
    off, exp, total, done = np.zeros((nc,nw)), np.zeros((nc,nw)), nc*nw, 0
    for c in range(nc):
        for w in range(nw):
            f,p = welch(x[c,w],fs=fs,nperseg=min(x.shape[-1],4096))
            off[c,w],exp[c,w] = _fit_aperiodic(f,p,fmin,fmax); done += 1
            if progress: progress(done,total)
    return {"offset":off,"exponent":exp}


def band_cordance(raw, fmin, fmax, window_size=2, overlap=50):
    fmin,fmax = _band(raw,fmin,fmax); x,fs = _spectral_windows(raw,window_size,overlap); out=[]
    for w in range(x.shape[1]):
        f,p = welch(x[:,w],fs=fs,axis=-1,nperseg=min(x.shape[-1],4096)); m=(f>=fmin)&(f<=fmax)
        if m.sum()<2: out.append(np.nan); continue
        c=np.corrcoef(p[:,m]); u=c[np.triu_indices_from(c,1)]; out.append(np.nanmean(u) if u.size else np.nan)
    return np.asarray(out)


def bandpower_asymmetry(raw, fmin, fmax, method="normalized asymmetry", window_size=2, overlap=50, channel_a="", channel_b=""):
    fmin,fmax = _band(raw,fmin,fmax)

    if channel_a and channel_b:
        if channel_a not in raw.ch_names or channel_b not in raw.ch_names:
            raise ValueError("Selected asymmetry channels were not found.")
        pairs=[(raw.ch_names.index(channel_a),raw.ch_names.index(channel_b))]
    else:
        pairs=[(i,i+1) for i in range(0,len(raw.ch_names)-1,2)]

    if not pairs:
        raise ValueError("At least two channels are required.")

    p = _bandpower(*_spectral_windows(raw, window_size, overlap), fmin, fmax)

    method=str(method).lower()
    out=[]

    for a,b in pairs:
        l,r=np.maximum(p[a],np.finfo(float).eps),np.maximum(p[b],np.finfo(float).eps)
        out.append((l-r)/(l+r) if method=="normalized asymmetry" else np.log(l/r))

    if method not in ("normalized asymmetry","log ratio","log power ratio"):
        raise ValueError("Unknown asymmetry method.")

    return np.asarray(out)

def apply_default_montage(raw):
    montage=mne.channels.make_standard_montage("standard_1005")

    names={x.upper():x for x in montage.ch_names}
    mapping={}

    for ch in raw.ch_names:
        key=ch.strip().rstrip(".").upper()
        if key in names:
            mapping[ch]=names[key]

    if mapping:
        raw.rename_channels(mapping)

    raw.set_montage(montage,on_missing="ignore")

    missing=[
        ch for ch in raw.ch_names
        if ch not in montage.ch_names
    ]

    print(f"Standard positions assigned to {len(raw.ch_names)-len(missing)}/{len(raw.ch_names)} channels.")

    if missing:
        print("Still missing positions:",missing)

    return raw

def run_ica(raw,n_components=15,brain_threshold=80):
    if raw is None: raise RuntimeError("No input signal.")
    threshold=float(brain_threshold)/100
    if not 0<=threshold<=1: raise ValueError("Brain threshold must be between 0 and 100 percent.")
    picks=mne.pick_types(raw.info,eeg=True,exclude="bads")
    if not len(picks): raise RuntimeError("No EEG channels available for ICA.")
    n_components=min(int(n_components),len(picks))
    if n_components<1: raise ValueError("Number of ICA components must be at least 1.")
    raw=apply_default_montage(raw)
    ica=ICA(n_components=n_components,method="fastica",random_state=97,max_iter=500); ica.fit(raw,picks=picks)
    classes=["brain","muscle artifact","eye blink","heart beat","line noise","channel noise","other"]
    try:
        prob=np.asarray(iclabel_label_components(raw,ica),float)
        if prob.ndim!=2 or prob.shape[1]!=7: raise ValueError
        labels=np.array([classes[i] for i in np.argmax(prob,1)])
    except Exception as exc:
        raise RuntimeError("ICLabel could not produce seven class probabilities. Check channel positions, recording rank and the inference backend.") from exc
    return {"ica":ica,"labels":labels,"probabilities":prob,
            "brain_components":[i for i in range(len(labels)) if prob[i,0]<threshold],
            "brain_threshold":threshold,"class_names":classes}


def remove_components(raw,ica,components):
    if raw is None: raise RuntimeError("No input signal.")
    if ica is None: raise RuntimeError("No ICA result is available.")
    ica.exclude=[] if components is None else [int(x) for x in components]
    return ica.apply(raw.copy())


def get_upstream_raw(node):
    if getattr(node,"raw",None) is not None: return node.raw
    for s in ([getattr(node,"in_node",None)] + list(getattr(node,"in_nodes",[]))):
        if s is not None:
            r=get_upstream_raw(s)
            if r is not None: return r
    return None


def export_table(nodes,filepath,mode="temporal"):
    if not filepath: raise ValueError("No output file selected.")
    series={}; filename=""; times=None
    for n in nodes or []:
        d=getattr(n,"features",None)
        if not isinstance(d,dict) or not isinstance(d.get("features"),dict): continue
        if times is None: times=np.asarray(d.get("times",[]),float)
        if not filename and getattr(n,"raw",None) is not None:
            fs=getattr(n.raw,"filenames",[]); filename=os.path.basename(fs[0]) if fs and fs[0] else ""
        series.update({str(k).replace(":","_").replace(" ","_"):np.asarray(v,float).ravel() for k,v in d["features"].items()})
    if not series: raise RuntimeError("No feature data available.")
    n=max(map(len,series.values())); times=np.arange(n) if times is None or len(times)<n else times
    os.makedirs(os.path.dirname(os.path.abspath(filepath)),exist_ok=True)
    with open(filepath,"w",newline="",encoding="utf-8") as f:
        w=csv.writer(f)
        if mode=="summary":
            w.writerow(["Filename",*series]); w.writerow([filename,*[float(np.nanmean(v)) for v in series.values()]])
        else:
            w.writerow(["Filename","Timestep",*series])
            for i in range(n): w.writerow([filename,times[i],*[v[i] if i<len(v) else "" for v in series.values()]])
    return filepath

def correlation(node):
    if len(node.in_nodes) != 2:
        raise RuntimeError("Correlation requires exactly two input nodes.")

    def values(n):
        if getattr(n,"features",None) is not None:
            d=n.features
            if not isinstance(d,dict) or not isinstance(d.get("features"),dict):
                raise RuntimeError(f"Invalid feature data from '{n.name}'.")
            return np.concatenate([
                np.asarray(v,float).ravel()
                for v in d["features"].values()
            ])
        if getattr(n,"raw",None) is not None:
            return np.asarray(n.raw.get_data(),float).ravel()
        if getattr(n,"data",None) is not None:
            return np.asarray(n.data,float).ravel()
        raise RuntimeError(f"No numeric data available from '{n.name}'.")

    x=values(node.in_nodes[0])
    y=values(node.in_nodes[1])

    if x.size != y.size:
        raise RuntimeError(
            f"Correlation inputs have different sizes: {x.size} vs {y.size}."
        )

    if x.size < 2:
        raise RuntimeError("Correlation requires at least two values.")

    if np.std(x)==0 or np.std(y)==0:
        raise RuntimeError("Correlation cannot be calculated from a constant signal.")

    node.correlation=float(np.corrcoef(x,y)[0,1])
    return node.correlation

def process_node(node,reuse_ica=False,progress=None):
    n,p=node.name,node.params
    if n=="Load SET":
        node.raw=load_set(p.get("filename","")); node.data=node.raw.get_data(); node.info=node.raw.info.copy(); return
    if n=="Load XLSX":
        raw=load_xlsx_eeg(p.get("filename",""),p.get("sfreq",256),p.get("unit","µV"))
        out=p.get("output") or os.path.splitext(p.get("filename",""))[0]+".set"; save_set(raw,out)
        node.raw=raw; node.data=raw.get_data(); node.info=raw.info.copy(); node.params["output"]=out; return   
    if n=="Load XDF":
        raw=load_xdf_eeg(p.get("filename",""),p.get("stream_index",0),p.get("sfreq",0),p.get("unit","V"))
        out=p.get("output") or os.path.splitext(p.get("filename",""))[0]+".set"; save_set(raw,out)
        node.raw=raw; node.data=raw.get_data(); node.info=raw.info.copy(); node.params["output"]=out; return
    if n=="Channel Selector":
        node.raw=channel_selector(get_upstream_raw(node),p.get("channels",[])); node.data=node.raw.get_data(); node.info=node.raw.info.copy(); return
    if n=="Bad Channel Labelling":
        r=label_bad_channels(get_upstream_raw(node),p.get("percentile",75),p.get("minsd",1),p.get("maxsd",100))
        node.raw=get_upstream_raw(node).copy(); node.raw.info["bads"]=r["bad_channels"]; node.info=r; node.bad_channel_info=r; return
    if n=="Export Table":
        export_table(node.in_nodes,p.get("filename",""),p.get("mode","temporal")); return
    if n=="Correlation":
        return correlation(node)
    raw=get_upstream_raw(node)
    if raw is None: raise RuntimeError(f"No input signal found for '{n}'.")
    if n in ("Bandpass","Bandpass Filter"): node.raw=bandpass(raw,p.get("low",1),p.get("high",40)); return
    if n in ("Z Score","Z-Score"): node.raw=zscore(raw); return
    if n in ("Crop","Crop Timing"): node.raw=crop(raw,p.get("start",0),p.get("stop",raw.times[-1])); return
    if n=="Resampler": node.raw=resample(raw,p.get("target_sfreq",250)); return
    if n=="Re-referencing": node.raw=rereference(raw,p.get("mode","average"),p.get("channel","")); return
    if n=="ICA":
        if reuse_ica and node.ica is not None: node.raw=raw; return
        r=run_ica(raw,p.get("n_components",15),p.get("brain_threshold",80)); node.ica=r["ica"]; node.ica_labels=r["labels"]; node.ica_probabilities=r["probabilities"]; node.ica_exclude=r["brain_components"]; node.raw=raw; return
    if n=="Bad Component Removal":
        s=getattr(node,"in_node",None)
        if s is None or s.ica is None: raise RuntimeError("No ICA result is available.")
        node.raw=remove_components(raw,s.ica,s.ica_exclude); return
    if n=="Power Feature Extraction":
        size,ov=p.get("window_size",2),p.get("overlap",50); r={"Power":power_feature(raw,p.get("fmin",8),p.get("fmax",12),p.get("method","Absolute Band Power"),size,ov)}
        node.features=_pack(raw,r,p.get("feature_name","Power"),p.get("method","Absolute Band Power"),size,ov,p.get("fmin",8),p.get("fmax",12)); return
    if n=="Periodic Band Power":
        size,ov=p.get("window_size",2),p.get("overlap",50); r={"Periodic":periodic_band_power(raw,p.get("fmin",8),p.get("fmax",12),p.get("fit_fmin",1),p.get("fit_fmax",45),size,ov,progress)}
        node.features=_pack(raw,r,p.get("feature_name","Periodic Power"),"Periodic Band Power",size,ov,p.get("fmin",8),p.get("fmax",12)); return
    if n=="Aperiodic 1/f":
        size,ov=p.get("window_size",4),p.get("overlap",50); r=aperiodic_feature(raw,p.get("fmin",1),p.get("fmax",40),size,ov,progress); par=str(p.get("parameter","Offset")).lower()
        if par not in ("offset","exponent"): raise ValueError("Aperiodic parameter must be Offset or Exponent.")
        node.features=_pack(raw,{par:r[par]},p.get("feature_name","Aperiodic"),par.title(),size,ov,p.get("fmin",1),p.get("fmax",40),"aperiodic"); return
    if n=="Band Cordance":
        size,ov=p.get("window_size",2),p.get("overlap",50); r={"Cordance":band_cordance(raw,p.get("fmin",4),p.get("fmax",8),size,ov)}
        node.features=_pack(raw,r,p.get("feature_name","Cordance"),"Band Cordance",size,ov,p.get("fmin",4),p.get("fmax",8),"cordance"); return
    if n=="Bandpower Asymmetry":
        size,ov=p.get("window_size",2),p.get("overlap",50)
        a,b=p.get("channel_a",""),p.get("channel_b","")
        r={"Asymmetry":bandpower_asymmetry(raw,p.get("fmin",8),p.get("fmax",12),p.get("method","Log Power Ratio"),size,ov,a,b)}
        node.features=_pack(raw,r,p.get("feature_name","Asymmetry"),p.get("method","Log Power Ratio"),size,ov,p.get("fmin",8),p.get("fmax",12),"asymmetry",(a,b)); return
    if n=="Save SET": save_set(raw,p.get("filename","")); node.raw=raw; return
    raise RuntimeError(f"Unknown node type: {n}")


def would_create_cycle(source,target):
    if source is target: return True
    seen=set(); stack=[target]
    while stack:
        n=stack.pop()
        if n is source: return True
        if n in seen: continue
        seen.add(n); stack.extend(getattr(n,"out_nodes",[]))
    return False


def has_cycle(nodes):
    seen,active=set(),set()
    def visit(n):
        if id(n) in active: return True
        if id(n) in seen: return False
        active.add(id(n))
        if any(visit(x) for x in getattr(n,"out_nodes",[])): return True
        active.remove(id(n)); seen.add(id(n)); return False
    return any(visit(n) for n in nodes)


def execution_order(nodes):
    seen,active,out=set(),set(),[]
    def visit(n):
        k=id(n)
        if k in active: raise RuntimeError("Workflow contains a cycle.")
        if k in seen: return
        active.add(k); src=[]
        if getattr(n,"in_node",None): src.append(n.in_node)
        src += [x for x in getattr(n,"in_nodes",[]) if x not in src]
        for x in src: visit(x)
        active.remove(k); seen.add(k); out.append(n)
    for n in nodes: visit(n)
    return out