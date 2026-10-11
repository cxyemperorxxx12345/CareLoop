// 知识库管理：宣教资料的新增、搜索、编辑与删除
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { BookOpen, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { clinicianApi } from '@/lib/api';
import { useDebounce } from '@/hooks/use-debounce';

// ===== 本地类型 =====
interface KnowledgeDoc {
  id: string;
  title: string;
  category: string;
  content: string;
  created_at: string;
}

// 分类选项（Select value 非空）
const CATEGORIES = ['用药指导', '饮食建议', '康复锻炼', '伤口护理', '复查须知', '其他'];

// 相对时间：xx分钟前 / xx小时前 / x天前 / 日期
function formatRelativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 7) return `${day} 天前`;
  return new Date(t).toLocaleDateString('zh-CN');
}

// 编辑弹窗的表单状态（null=关闭）
interface DraftDoc {
  id?: string;
  title: string;
  category: string;
  content: string;
}

export function KnowledgePage() {
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const debouncedKeyword = useDebounce(keyword, 300);

  // 新增/编辑共用一个 Dialog
  const [draft, setDraft] = useState<DraftDoc | null>(null);
  const [saving, setSaving] = useState(false);
  // 待删除文档
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeDoc | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async (kw: string) => {
    setLoading(true);
    try {
      const rows = (await clinicianApi.knowledge(kw || undefined)) as unknown as KnowledgeDoc[];
      setDocs(rows);
    } catch (e) {
      toast.error(`加载知识库失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // 防抖 300ms 后按关键词搜索
  useEffect(() => {
    void load(debouncedKeyword.trim());
  }, [load, debouncedKeyword]);

  const openCreate = () => setDraft({ title: '', category: '', content: '' });
  const openEdit = (doc: KnowledgeDoc) =>
    setDraft({ id: doc.id, title: doc.title, category: doc.category, content: doc.content });

  const saveDoc = async () => {
    if (!draft) return;
    if (!draft.title.trim()) {
      toast.error('请填写标题');
      return;
    }
    if (!draft.category) {
      toast.error('请选择分类');
      return;
    }
    if (!draft.content.trim()) {
      toast.error('请填写内容');
      return;
    }
    setSaving(true);
    try {
      await clinicianApi.saveKnowledge({
        id: draft.id,
        title: draft.title.trim(),
        category: draft.category,
        content: draft.content.trim(),
      });
      toast.success(draft.id ? '资料已更新' : '资料已新增');
      setDraft(null);
      await load(debouncedKeyword.trim());
    } catch (e) {
      toast.error(`保存失败：${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const removeDoc = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await clinicianApi.deleteKnowledge(deleteTarget.id);
      toast.success('资料已删除');
      setDeleteTarget(null);
      await load(debouncedKeyword.trim());
    } catch (e) {
      toast.error(`删除失败：${(e as Error).message}`);
    } finally {
      setDeleting(false);
    }
  };

  const updateDraft = (patch: Partial<DraftDoc>) =>
    setDraft(prev => (prev ? { ...prev, ...patch } : prev));

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg md:text-xl font-bold">知识库</h1>
          <p className="text-sm text-muted-foreground mt-0.5">管理出院宣教与随访知识资料</p>
        </div>
        <Button type="button" onClick={openCreate}>
          <Plus className="h-4 w-4 mr-1.5" />
          新增资料
        </Button>
      </div>

      {/* 搜索（防抖 300ms） */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="搜索标题或内容…"
          value={keyword}
          onChange={e => setKeyword(e.target.value)}
        />
      </div>

      {/* 资料网格 */}
      {loading ? (
        <p className="text-sm text-muted-foreground text-center py-10">加载中…</p>
      ) : docs.length === 0 ? (
        <Card>
          <CardContent className="p-10 flex flex-col items-center gap-3 text-center">
            <BookOpen className="h-10 w-10 text-muted-foreground" />
            <div className="space-y-1">
              <p className="text-sm font-bold">
                {debouncedKeyword.trim() ? '没有找到匹配的资料' : '知识库还是空的'}
              </p>
              <p className="text-sm text-muted-foreground">
                {debouncedKeyword.trim()
                  ? '换个关键词试试，或新增一份资料'
                  : '点击右上角「新增资料」，录入第一份宣教内容'}
              </p>
            </div>
            {debouncedKeyword.trim() ? (
              <Button type="button" variant="outline" size="sm" onClick={openCreate}>
                <Plus className="h-4 w-4 mr-1.5" />
                新增资料
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {docs.map(doc => (
            <Card key={doc.id} className="flex flex-col">
              <CardContent className="p-4 flex flex-col gap-2 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <Badge variant="secondary" className="bg-secondary">{doc.category}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {formatRelativeTime(doc.created_at)}
                  </span>
                </div>
                <p className="font-bold text-sm leading-snug">{doc.title}</p>
                <p className="text-sm text-muted-foreground line-clamp-4 flex-1 whitespace-pre-wrap">
                  {doc.content}
                </p>
                <div className="flex justify-end gap-1 pt-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="编辑"
                    onClick={() => openEdit(doc)}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="删除"
                    onClick={() => setDeleteTarget(doc)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* 新增/编辑弹窗 */}
      <Dialog open={draft !== null} onOpenChange={open => !open && setDraft(null)}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg">
          <DialogHeader>
            <DialogTitle>{draft?.id ? '编辑资料' : '新增资料'}</DialogTitle>
            <DialogDescription>填写标题、分类与宣教内容，带 * 为必填项</DialogDescription>
          </DialogHeader>
          {draft ? (
            <form
              className="space-y-4"
              onSubmit={e => {
                e.preventDefault();
                void saveDoc();
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="doc-title">标题 *</Label>
                <Input
                  id="doc-title"
                  required
                  placeholder="例如：术后伤口护理要点"
                  value={draft.title}
                  onChange={e => updateDraft({ title: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="doc-category">分类 *</Label>
                <Select value={draft.category} onValueChange={v => updateDraft({ category: v })} required>
                  <SelectTrigger id="doc-category" className="w-full">
                    <SelectValue placeholder="请选择分类" />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map(c => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="doc-content">内容 *</Label>
                <Textarea
                  id="doc-content"
                  rows={8}
                  required
                  placeholder="填写宣教正文，支持换行"
                  value={draft.content}
                  onChange={e => updateDraft({ content: e.target.value })}
                />
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDraft(null)}
                  disabled={saving}
                >
                  取消
                </Button>
                <Button type="submit" disabled={saving}>
                  {saving ? '保存中…' : '保存'}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={open => !open && setDeleteTarget(null)}>
        <AlertDialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除？</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget ? `「${deleteTarget.title}」删除后不可恢复，请谨慎操作。` : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button" disabled={deleting}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              type="button"
              className="bg-destructive text-destructive-foreground"
              onClick={e => {
                e.preventDefault();
                void removeDoc();
              }}
              disabled={deleting}
            >
              {deleting ? '删除中…' : '确认删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default KnowledgePage;
