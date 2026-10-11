// 出院资料：图片上传（超限自动压缩）→ AI 解析轮询 → 校对/手动录入 → 确认生成计划
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, Loader2, UploadCloud, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/db/supabase';
import { fnApi, getMyPatient, patientApi } from '@/lib/api';
import { cn } from '@/lib/utils';

const MAX_SIZE = 1024 * 1024; // 1MB
const SLOT_OPTIONS = ['早 8:00', '中 12:00', '晚 18:00', '睡前 21:00'];

// 解析结果与校对表单的本地类型
interface ParsedMedication { medicine_name?: string; spec?: string; dosage?: string; frequency?: string; slots?: number[]; note?: string; }
interface ParsedFollowup { title?: string; due_date?: string; category?: string; detail?: string; }
interface ParsedDoc { diagnosis?: string; medications?: ParsedMedication[]; followups?: ParsedFollowup[]; instructions?: string; }
interface DocRow { id: string; file_url: string; status: string; parsed_json: ParsedDoc | null; error_message: string | null; created_at: string; }
interface MedForm { medicine_name: string; spec: string; dosage: string; frequency: string; slots: number[]; note: string; }
interface FuForm { title: string; due_date: string; category: string; detail: string; }

const emptyMed = (): MedForm => ({ medicine_name: '', spec: '', dosage: '', frequency: '', slots: [], note: '' });
const emptyFu = (): FuForm => ({ title: '', due_date: '', category: 'followup', detail: '' });

type Phase = 'idle' | 'uploading' | 'parsing' | 'parsed' | 'failed' | 'manual';

const STATUS_META: Record<string, { label: string; cls: string }> = {
  pending: { label: '待解析', cls: 'bg-muted text-muted-foreground' },
  parsing: { label: '解析中', cls: 'bg-triage-amber-bg text-triage-amber' },
  parsed: { label: '待确认', cls: 'bg-triage-amber-bg text-triage-amber' },
  confirmed: { label: '已确认', cls: 'bg-triage-green-bg text-triage-green' },
  failed: { label: '解析失败', cls: 'bg-triage-red-bg text-triage-red' },
};

// 文件名 stem 做 hex 编码保留扩展名，避免特殊字符问题
function buildHexName(rawName: string, ext: string): string {
  const dot = rawName.lastIndexOf('.');
  const stem = dot > 0 ? rawName.slice(0, dot) : rawName;
  const bytes = new TextEncoder().encode(stem || 'document');
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex}${ext}`;
}

// 展示文件名：hex stem 解码回原文本，失败则回退原始片段
function displayName(fileUrl: string): string {
  const seg = fileUrl.split('/').pop() ?? fileUrl;
  const dot = seg.lastIndexOf('.');
  const stem = dot > 0 ? seg.slice(0, dot) : seg;
  const ext = dot > 0 ? seg.slice(dot) : '';
  if (/^[0-9a-f]+$/.test(stem) && stem.length % 2 === 0) {
    try {
      const bytes = new Uint8Array(stem.match(/.{1,2}/g)!.map((h) => parseInt(h, 16)));
      return new TextDecoder().decode(bytes) + ext;
    } catch {
      return seg;
    }
  }
  return seg;
}

// canvas 压缩：最长边限制 + WEBP 质量
async function compressImage(file: File, maxSide: number, quality: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前环境不支持图片压缩');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
  if (!blob) throw new Error('图片压缩失败，请换一张');
  return blob;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function slotsText(slots?: number[]): string {
  if (!Array.isArray(slots) || slots.length === 0) return '';
  return `（${slots.map((s) => SLOT_OPTIONS[s] ?? `时段${s}`).join('、')}）`;
}

function StatusCard({ icon, title, desc }: { icon: ReactNode; title: string; desc: string }) {
  return (
    <Card className="rounded-2xl">
      <CardContent className="flex items-center gap-3 p-4">
        <span className="shrink-0">{icon}</span>
        <div className="min-w-0">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-xs text-muted-foreground">{desc}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export function DocumentsPage() {
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const timersRef = useRef<number[]>([]);
  const aliveRef = useRef(true);
  const [loading, setLoading] = useState(true);
  const [patientId, setPatientId] = useState<string | null>(null);
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [activeDocId, setActiveDocId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [meds, setMeds] = useState<MedForm[]>([]);
  const [fus, setFus] = useState<FuForm[]>([]);
  const [instructions, setInstructions] = useState('');
  const [diagnosis, setDiagnosis] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [viewDoc, setViewDoc] = useState<DocRow | null>(null);

  // 卸载时清理轮询定时器
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      timersRef.current.forEach((t) => window.clearInterval(t));
    };
  }, []);

  const loadDocs = useCallback(async (pid: string) => {
    const rows = (await patientApi.documents(pid)) as unknown as DocRow[];
    if (aliveRef.current) setDocs(rows);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const p = await getMyPatient();
        if (!alive) return;
        if (p) {
          setPatientId(p.id);
          await loadDocs(p.id);
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : '加载失败，请稍后重试');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [loadDocs]);

  const flowBusy = phase === 'uploading' || phase === 'parsing';

  const fillForm = useCallback((pj: ParsedDoc | null) => {
    setMeds(
      (pj?.medications ?? []).map((m) => ({
        medicine_name: m.medicine_name ?? '',
        spec: m.spec ?? '',
        dosage: m.dosage ?? '',
        frequency: m.frequency ?? '',
        slots: Array.isArray(m.slots) ? m.slots.filter((n) => n >= 0 && n <= 3) : [],
        note: m.note ?? '',
      })),
    );
    setFus(
      (pj?.followups ?? []).map((f) => ({
        title: f.title ?? '',
        due_date: (f.due_date ?? '').slice(0, 10),
        category: f.category ?? 'followup',
        detail: f.detail ?? '',
      })),
    );
    setInstructions(pj?.instructions ?? '');
    setDiagnosis(pj?.diagnosis ?? '');
  }, []);

  // 每 3 秒轮询解析状态，直到 parsed / failed
  const pollDocument = useCallback(
    (docId: string, pid: string) => {
      const timer = window.setInterval(async () => {
        const { data, error } = await supabase
          .from('documents')
          .select('status, parsed_json, error_message')
          .eq('id', docId)
          .maybeSingle();
        if (!aliveRef.current || error) return;
        const row = data as { status: string; parsed_json: ParsedDoc | null; error_message: string | null } | null;
        if (!row) return;
        if (row.status === 'parsed') {
          window.clearInterval(timer);
          fillForm(row.parsed_json);
          setPhase('parsed');
          toast.success('解析完成，请校对识别结果');
          void loadDocs(pid);
        } else if (row.status === 'failed') {
          window.clearInterval(timer);
          setErrorMsg(row.error_message ?? '识别服务繁忙，请重试');
          setPhase('failed');
          void loadDocs(pid);
        }
      }, 3000);
      timersRef.current.push(timer);
    },
    [fillForm, loadDocs],
  );

  async function handleFile(file: File) {
    const pid = patientId;
    if (!pid || flowBusy) return;
    if (!file.type.startsWith('image/')) {
      toast.error('仅支持上传图片文件');
      return;
    }
    setPhase('uploading');
    try {
      const { data: userData } = await supabase.auth.getUser();
      const uid = userData.user?.id;
      if (!uid) throw new Error('登录状态已失效，请重新登录');

      // 超过 1MB 自动压缩：1080/0.8 → 800/0.7 → 640/0.6 递降
      let blob: Blob = file;
      let ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase() : '';
      if (file.size > MAX_SIZE) {
        const steps: Array<[number, number]> = [[1080, 0.8], [800, 0.7], [640, 0.6]];
        for (const [side, q] of steps) {
          blob = await compressImage(file, side, q);
          if (blob.size <= MAX_SIZE) break;
        }
        if (blob.size > MAX_SIZE) throw new Error('图片过大，压缩后仍超过 1MB，请换一张');
        ext = blob.type === 'image/webp' ? '.webp' : blob.type === 'image/png' ? '.png' : '.jpg';
      }

      const safeName = buildHexName(file.name, ext);
      let path = `${uid}/${safeName}`;
      const { error: upErr } = await supabase.storage.from('documents').upload(path, blob, {
        contentType: blob.type || 'image/webp',
      });
      if (upErr && upErr.message.includes('Duplicate')) {
        // 同名文件已存在时追加时间戳重试
        path = `${uid}/${Date.now().toString(36)}-${safeName}`;
        const { error: retryErr } = await supabase.storage.from('documents').upload(path, blob, {
          contentType: blob.type || 'image/webp',
        });
        if (retryErr) throw retryErr;
      } else if (upErr) {
        throw upErr;
      }

      const { data: inserted, error: insErr } = await supabase
        .from('documents')
        .insert({ patient_id: pid, file_url: path })
        .select('id')
        .single();
      if (insErr) throw insErr;
      const docId = (inserted as { id: string }).id;
      setActiveDocId(docId);
      setPhase('parsing');
      void loadDocs(pid);
      pollDocument(docId, pid);
      try {
        await fnApi.parseDocument(docId);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : '解析服务调用失败，请稍后在记录中查看');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '上传失败，请重试');
      setPhase('idle');
    }
  }

  // 手动录入（解析失败的降级路径，跳过解析直接确认）
  function startManual() {
    fillForm(null);
    setMeds([emptyMed()]);
    setFus([emptyFu()]);
    setPhase('manual');
  }

  function resetFlow() {
    setPhase('idle');
    setActiveDocId(null);
    setErrorMsg('');
  }

  const patchMed = (i: number, patch: Partial<MedForm>) =>
    setMeds((prev) => prev.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));
  const patchFu = (i: number, patch: Partial<FuForm>) =>
    setFus((prev) => prev.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));

  function toggleSlot(i: number, slot: number, checked: boolean) {
    setMeds((prev) =>
      prev.map((m, idx) =>
        idx === i
          ? { ...m, slots: checked ? [...m.slots, slot] : m.slots.filter((s) => s !== slot) }
          : m,
      ),
    );
  }

  async function handleConfirm() {
    if (!activeDocId || !patientId || confirming) return;
    const validMeds = meds.filter((m) => m.medicine_name.trim());
    if (validMeds.length === 0) {
      toast.error('请至少填写一条用药（药品名必填）');
      return;
    }
    setConfirming(true);
    try {
      await fnApi.confirmPlan(activeDocId, {
        diagnosis: diagnosis.trim(),
        instructions: instructions.trim(),
        medications: validMeds.map((m) => ({
          ...m,
          medicine_name: m.medicine_name.trim(),
          slots: [...m.slots].sort((a, b) => a - b),
        })),
        followups: fus
          .filter((f) => f.title.trim())
          .map((f) => ({ ...f, title: f.title.trim() })),
      });
      toast.success('照护计划已生成');
      resetFlow();
      await loadDocs(patientId);
      navigate('/patient/medications');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '生成失败，请重试');
    } finally {
      setConfirming(false);
    }
  }

  if (loading) {
    return (
      <div className="p-4 space-y-4">
        <div className="space-y-2 pt-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-32 w-full rounded-2xl" />
        <Skeleton className="h-20 w-full rounded-2xl" />
        <Skeleton className="h-20 w-full rounded-2xl" />
      </div>
    );
  }

  if (!patientId) {
    return (
      <div className="p-4 pt-10">
        <Card className="rounded-2xl">
          <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
            <UploadCloud className="h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">还没有找到您的患者档案，请先登录后再上传出院资料。</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const viewParsed = viewDoc?.parsed_json ?? null;

  return (
    <div className="p-4 space-y-4">
      <div className="pt-2">
        <h1 className="text-2xl font-bold">出院资料</h1>
        <p className="mt-1 text-sm text-muted-foreground">上传出院小结或医嘱单，自动识别生成用药与随访计划</p>
      </div>

      {/* 上传区 */}
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={flowBusy}
        className="flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-border bg-muted/40 p-6 text-center disabled:opacity-60"
      >
        <UploadCloud className="h-8 w-8 text-primary" />
        <span className="text-sm font-medium">点击上传出院资料图片</span>
        <span className="text-xs text-muted-foreground">仅支持图片，超过 1MB 自动压缩</span>
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void handleFile(f);
        }}
      />

      {/* 流程状态 */}
      {phase === 'uploading' && (
        <StatusCard icon={<Loader2 className="h-5 w-5 animate-spin text-primary" />} title="上传中" desc="正在保存图片，请稍候…" />
      )}
      {phase === 'parsing' && (
        <StatusCard icon={<Loader2 className="h-5 w-5 animate-spin text-primary" />} title="智能解析中" desc="上传成功，正在识别内容，约需几十秒…" />
      )}

      {/* 解析失败：错误条 + 降级入口 */}
      {phase === 'failed' && (
        <div className="space-y-3">
          <div className="flex items-start gap-2 rounded-2xl bg-triage-red-bg p-3">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-triage-red" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-triage-red">解析失败</p>
              <p className="mt-0.5 break-words text-sm text-triage-red/80">{errorMsg || '识别服务繁忙，请重试'}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="flex-1 rounded-2xl" onClick={resetFlow}>
              重新上传
            </Button>
            <Button type="button" variant="outline" className="flex-1 rounded-2xl" onClick={startManual}>
              手动录入
            </Button>
          </div>
        </div>
      )}

      {/* 校对 / 手动录入表单 */}
      {(phase === 'parsed' || phase === 'manual') && (
        <Card className="rounded-2xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{phase === 'manual' ? '手动录入计划' : '校对识别结果'}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs">诊断（选填）</Label>
              <Input value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)} placeholder="如：高血压 2 级" />
            </div>

            {/* 用药计划编辑 */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs">用药计划</Label>
                <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => setMeds((prev) => [...prev, emptyMed()])}>
                  + 添加药品
                </Button>
              </div>
              {meds.map((m, i) => (
                <Card key={i} className="rounded-2xl bg-muted/40">
                  <CardContent className="space-y-3 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">药品 {i + 1}</span>
                      {meds.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="shrink-0"
                          onClick={() => setMeds((prev) => prev.filter((_, idx) => idx !== i))}
                        >
                          删除
                        </Button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Input value={m.medicine_name} onChange={(e) => patchMed(i, { medicine_name: e.target.value })} placeholder="药品名 *" />
                      <Input value={m.spec} onChange={(e) => patchMed(i, { spec: e.target.value })} placeholder="规格 如 0.5g*20片" />
                      <Input value={m.dosage} onChange={(e) => patchMed(i, { dosage: e.target.value })} placeholder="单次剂量 如 1片" />
                      <Input value={m.frequency} onChange={(e) => patchMed(i, { frequency: e.target.value })} placeholder="频次 如 每日三次" />
                    </div>
                    <div className="space-y-1.5">
                      <p className="text-xs text-muted-foreground">服用时间（可多选）</p>
                      <div className="flex flex-wrap gap-x-4 gap-y-2">
                        {SLOT_OPTIONS.map((label, slot) => (
                          <label key={slot} className="flex items-center gap-1.5 text-sm">
                            <Checkbox checked={m.slots.includes(slot)} onCheckedChange={(c) => toggleSlot(i, slot, c === true)} />
                            {label}
                          </label>
                        ))}
                      </div>
                    </div>
                    <Input value={m.note} onChange={(e) => patchMed(i, { note: e.target.value })} placeholder="备注（选填）" />
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* 随访事项编辑 */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs">随访事项</Label>
                <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => setFus((prev) => [...prev, emptyFu()])}>
                  + 添加随访
                </Button>
              </div>
              {fus.map((f, i) => (
                <div key={i} className="space-y-2 rounded-2xl bg-muted/40 p-3">
                  <div className="flex items-center gap-2">
                    <Input className="min-w-0 flex-1" value={f.title} onChange={(e) => patchFu(i, { title: e.target.value })} placeholder="如 术后一周复查血常规 *" />
                    {fus.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="shrink-0"
                        onClick={() => setFus((prev) => prev.filter((_, idx) => idx !== i))}
                      >
                        删除
                      </Button>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Input type="date" className="min-w-0 flex-1" value={f.due_date} onChange={(e) => patchFu(i, { due_date: e.target.value })} />
                    <Input className="min-w-0 flex-1" value={f.detail} onChange={(e) => patchFu(i, { detail: e.target.value })} placeholder="详情（选填）" />
                  </div>
                </div>
              ))}
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">注意事项</Label>
              <Textarea rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="如：低盐饮食，如有发热请及时就诊" />
            </div>

            <div className="flex gap-2">
              <Button type="button" variant="outline" className="flex-1 rounded-2xl" onClick={resetFlow}>
                暂不校对
              </Button>
              <Button type="button" className="flex-[2] rounded-2xl" disabled={confirming} onClick={handleConfirm}>
                {confirming && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                确认生成计划
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 历史记录 */}
      <div>
        <h2 className="mb-2 text-base font-semibold">上传记录</h2>
        {docs.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有上传过资料</p>
        ) : (
          <div className="space-y-2">
            {docs.map((d) => {
              const meta = STATUS_META[d.status] ?? STATUS_META.pending;
              return (
                <Card key={d.id} className="rounded-2xl">
                  <CardContent className="flex items-center gap-2 p-3">
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{displayName(d.file_url)}</p>
                      <p className="text-xs text-muted-foreground">{formatTime(d.created_at)}</p>
                    </div>
                    <Badge variant="secondary" className={cn('shrink-0', meta.cls)}>
                      {meta.label}
                    </Badge>
                    {d.status === 'confirmed' && (
                      <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => setViewDoc(d)}>
                        查看
                      </Button>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* 已确认文档查看弹窗（只读） */}
      <Dialog open={viewDoc !== null} onOpenChange={(open) => !open && setViewDoc(null)}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="break-all text-base">{viewDoc ? displayName(viewDoc.file_url) : ''}</DialogTitle>
            <DialogDescription>{viewDoc ? `上传于 ${formatTime(viewDoc.created_at)} · 已确认的计划内容` : ''}</DialogDescription>
          </DialogHeader>
          {viewParsed ? (
            <div className="space-y-3 text-sm">
              {viewParsed.diagnosis && (
                <div>
                  <p className="font-medium">诊断</p>
                  <p className="text-muted-foreground">{viewParsed.diagnosis}</p>
                </div>
              )}
              <div>
                <p className="font-medium">用药计划</p>
                <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
                  {(viewParsed.medications ?? []).map((m, i) => (
                    <li key={i}>
                      {[m.medicine_name, m.spec, m.dosage, m.frequency].filter(Boolean).join(' ')}
                      {slotsText(m.slots)}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="font-medium">随访事项</p>
                <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
                  {(viewParsed.followups ?? []).map((f, i) => (
                    <li key={i}>
                      {[f.title, f.due_date].filter(Boolean).join(' · ')}
                    </li>
                  ))}
                </ul>
              </div>
              {viewParsed.instructions && (
                <div>
                  <p className="font-medium">注意事项</p>
                  <p className="whitespace-pre-wrap text-muted-foreground">{viewParsed.instructions}</p>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">暂无解析内容</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
export default DocumentsPage;
