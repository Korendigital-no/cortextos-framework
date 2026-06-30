'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ToastProvider, useToast } from '@/components/ui/toast';
import DeleteTaskDialog from '@/components/clients/delete-task-dialog';
import DeleteTimeEntryDialog from '@/components/clients/delete-time-entry-dialog';
import EditClientDialog from '@/components/clients/edit-client-dialog';
import DeleteClientDialog from '@/components/clients/delete-client-dialog';
import { deleteClientTask } from '@/lib/client-tasks';
import {
  IconArrowLeft, IconClock, IconPlus, IconCircleCheck, IconCircle, IconTrash,
  IconPencil, IconArchive, IconArchiveOff,
} from '@tabler/icons-react';

interface Client {
  id: string;
  company_name: string;
  contact_name: string | null;
  contact_email: string | null;
  deal_type: string | null;
  rate_nok: number | null;
  hours_commitment: string | null;
  rate_description: string | null;
  status: string;
  notes: string | null;
  deleted_at: string | null;
}

interface TimeEntry { id: string; description: string; hours: number; date: string; agent: string | null; project_id: string | null; }
interface Project { id: string; name: string; description: string | null; status: string; due_at: string | null; budget_hours: number | null; total_hours: number; open_tasks: number; }
interface ClientTask { id: string; title: string; status: string; priority: string; due_at: string | null; project_id: string | null; }
interface Note { id: string; body: string; project_id: string | null; created_at: string; }

type Tab = 'overview' | 'projects' | 'tasks' | 'notes';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('nb-NO', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatNOK(value: number): string {
  return new Intl.NumberFormat('nb-NO', { maximumFractionDigits: 0 }).format(value);
}

export default function ClientDetailPage() {
  return (
    <ToastProvider>
      <ClientDetailView />
    </ToastProvider>
  );
}

function ClientDetailView() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('overview');
  const [showEdit, setShowEdit] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  // Server truth for the archive-vs-delete decision (counts trashed entries too,
  // unlike totals.entry_count which is live-only).
  const [hasTimeHistory, setHasTimeHistory] = useState(false);
  const [client, setClient] = useState<Client | null>(null);
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<ClientTask[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [totals, setTotals] = useState({ total_hours: 0, entry_count: 0 });
  const [loading, setLoading] = useState(true);

  const [showAddTime, setShowAddTime] = useState(false);
  const [timeDesc, setTimeDesc] = useState('');
  const [timeHours, setTimeHours] = useState('');
  const [timeDate, setTimeDate] = useState(new Date().toISOString().split('T')[0]);

  const [showAddProject, setShowAddProject] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [projectDesc, setProjectDesc] = useState('');

  const [showAddTask, setShowAddTask] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDue, setTaskDue] = useState('');
  const [taskPriority, setTaskPriority] = useState('normal');
  const [taskToDelete, setTaskToDelete] = useState<ClientTask | null>(null);
  const [timeEntryToDelete, setTimeEntryToDelete] = useState<TimeEntry | null>(null);

  const [showAddNote, setShowAddNote] = useState(false);
  const [noteBody, setNoteBody] = useState('');

  // Monotonic request id: a later fetchAll() supersedes an in-flight earlier one,
  // so out-of-order responses are discarded. Without this, clicking Undo while
  // the post-delete fetchAll() is still running could let the deleted-state
  // response land AFTER the restore refresh and overwrite the restored entry
  // and totals (codex P2). Only the latest request applies its result.
  const fetchSeq = useRef(0);

  const fetchAll = useCallback(async () => {
    const seq = ++fetchSeq.current;
    try {
      const [cRes, pRes, tRes, nRes] = await Promise.all([
        fetch(`/api/clients/${id}`),
        fetch(`/api/clients/${id}/projects`),
        fetch(`/api/clients/${id}/tasks`),
        fetch(`/api/clients/${id}/notes`),
      ]);
      // Read all bodies, THEN gate on the sequence so a superseded response
      // cannot apply even partially.
      const [cData, pData, tData, nData] = await Promise.all([
        cRes.ok ? cRes.json() : null,
        pRes.ok ? pRes.json() : null,
        tRes.ok ? tRes.json() : null,
        nRes.ok ? nRes.json() : null,
      ]);
      if (seq !== fetchSeq.current) return; // superseded — discard stale state
      if (cData) {
        setClient(cData.client);
        setTimeEntries(cData.timeEntries);
        setTotals(cData.totals);
        setHasTimeHistory(!!cData.has_time_history);
      }
      if (pData) setProjects(pData);
      if (tData) setTasks(tData);
      if (nData) setNotes(nData);
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  async function handleAddTime() {
    if (!timeDesc.trim() || !timeHours) return;
    await fetch(`/api/clients/${id}/time-entries`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: timeDesc.trim(), hours: parseFloat(timeHours), date: timeDate }),
    });
    setTimeDesc(''); setTimeHours(''); setTimeDate(new Date().toISOString().split('T')[0]); setShowAddTime(false);
    fetchAll();
  }

  async function handleAddProject() {
    if (!projectName.trim()) return;
    await fetch(`/api/clients/${id}/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: projectName.trim(), description: projectDesc.trim() || undefined }),
    });
    setProjectName(''); setProjectDesc(''); setShowAddProject(false);
    fetchAll();
  }

  async function handleAddTask() {
    if (!taskTitle.trim()) return;
    await fetch(`/api/clients/${id}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: taskTitle.trim(), due_at: taskDue || undefined, priority: taskPriority }),
    });
    setTaskTitle(''); setTaskDue(''); setTaskPriority('normal'); setShowAddTask(false);
    fetchAll();
  }

  async function handleAddNote() {
    if (!noteBody.trim()) return;
    await fetch(`/api/clients/${id}/notes`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: noteBody.trim() }),
    });
    setNoteBody(''); setShowAddNote(false);
    fetchAll();
  }

  async function toggleTask(taskId: string, currentStatus: string) {
    const newStatus = currentStatus === 'completed' ? 'pending' : 'completed';
    await fetch(`/api/clients/${id}/tasks/${taskId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });
    fetchAll();
  }

  async function confirmDeleteTask() {
    if (!taskToDelete) return;
    const target = taskToDelete;
    const result = await deleteClientTask(id, target.id);
    setTaskToDelete(null);
    if (result.ok) {
      // Optimistically drop the row for instant feedback, then refetch so
      // dependent views stay correct: project open-task counts, overview
      // stats, and any task created in another tab since the last load.
      setTasks(prev => prev.filter(t => t.id !== target.id));
      fetchAll();
    } else {
      toast({ message: result.error, variant: 'error' });
    }
  }

  async function confirmDeleteTimeEntry() {
    if (!timeEntryToDelete) return;
    const target = timeEntryToDelete;
    setTimeEntryToDelete(null);
    const res = await fetch(`/api/clients/${id}/time-entries/${target.id}`, { method: 'DELETE' });
    if (!res.ok) {
      toast({ message: 'Could not delete time entry', variant: 'error' });
      return;
    }
    // Optimistic drop for instant feedback, then refetch so the work log and the
    // overview totals (total_hours / entry_count) stay correct.
    setTimeEntries(prev => prev.filter(t => t.id !== target.id));
    fetchAll();
    // The entry was archived, not destroyed — offer a one-click restore so a
    // mis-click never loses logged time.
    toast({
      message: `Deleted ${target.hours.toFixed(1)}h — ${target.description}`,
      variant: 'info',
      action: {
        label: 'Undo',
        onClick: async () => {
          const r = await fetch(`/api/clients/${id}/time-entries/${target.id}/restore`, { method: 'POST' });
          if (r.ok) {
            toast({ message: 'Time entry restored', variant: 'success' });
            fetchAll();
          } else {
            toast({ message: 'Could not restore time entry', variant: 'error' });
          }
        },
      },
    });
  }

  async function handleRestore() {
    const res = await fetch(`/api/clients/${id}/restore`, { method: 'POST' });
    if (res.ok) {
      toast({ message: 'Client restored', variant: 'success' });
      fetchAll();
    } else {
      toast({ message: 'Could not restore client', variant: 'error' });
    }
  }

  async function handleDeleteClient() {
    setShowDelete(false);
    const name = client?.company_name ?? 'client';
    const res = await fetch(`/api/clients/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      toast({ message: 'Could not remove client', variant: 'error' });
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (data.soft) {
      // Archived (recoverable): stay, refresh to surface the archived state, and
      // offer an instant Undo. Billing history is preserved on the server.
      fetchAll();
      toast({
        message: `Archived ${name} — billing history preserved`,
        variant: 'info',
        action: { label: 'Undo', onClick: handleRestore },
      });
    } else {
      // Hard-deleted (a client that never logged time) — it's gone; go back.
      router.push('/clients');
    }
  }

  if (loading) return <div className="space-y-4"><div className="h-8 w-48 rounded bg-muted/30 animate-pulse" /><div className="h-64 rounded-lg bg-muted/30 animate-pulse" /></div>;
  if (!client) return <div className="space-y-4"><Link href="/clients"><Button variant="ghost" size="sm"><IconArrowLeft className="size-4 mr-1" />Back</Button></Link><p className="text-sm text-muted-foreground">Client not found.</p></div>;

  const revenue = client.rate_nok ? totals.total_hours * client.rate_nok : null;
  const activeProjects = projects.filter(p => p.status === 'active').length;
  const openTasks = tasks.filter(t => t.status !== 'completed').length;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Link href="/clients"><Button variant="ghost" size="icon-sm"><IconArrowLeft className="size-4" /></Button></Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold">{client.company_name}</h1>
              <Badge variant="secondary" className={client.status === 'active' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : ''}>{client.status}</Badge>
              {client.deleted_at && <Badge variant="secondary" className="bg-amber-500/10 text-amber-700 dark:text-amber-400">Archived</Badge>}
            </div>
            <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground">
              {client.contact_name && <span>{client.contact_name}</span>}
              {client.deal_type && <span>{client.deal_type}</span>}
              {client.rate_nok && <span>{formatNOK(client.rate_nok)} kr/t ex MVA</span>}
              {client.hours_commitment && <span>{client.hours_commitment}</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {client.deleted_at ? (
            <Button variant="outline" size="sm" onClick={handleRestore}><IconArchiveOff className="size-4 mr-1" />Restore</Button>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={() => setShowEdit(true)}><IconPencil className="size-4 mr-1" />Edit</Button>
              <Button variant="outline" size="sm" onClick={() => setShowDelete(true)} className="text-destructive hover:text-destructive">
                {hasTimeHistory ? <IconArchive className="size-4 mr-1" /> : <IconTrash className="size-4 mr-1" />}
                {hasTimeHistory ? 'Archive' : 'Delete'}
              </Button>
            </>
          )}
        </div>
      </div>

      <EditClientDialog
        open={showEdit}
        client={{
          id: client.id,
          company_name: client.company_name,
          contact_name: client.contact_name,
          contact_email: client.contact_email,
          deal_type: client.deal_type,
          rate_nok: client.rate_nok,
          rate_description: client.rate_description,
          hours_commitment: client.hours_commitment,
          status: client.status,
          notes: client.notes,
        }}
        onSaved={() => { setShowEdit(false); fetchAll(); }}
        onCancel={() => setShowEdit(false)}
      />
      <DeleteClientDialog
        open={showDelete}
        companyName={client.company_name}
        hasTimeHistory={hasTimeHistory}
        entryCount={totals.entry_count}
        totalHours={totals.total_hours}
        projectCount={projects.length}
        onConfirm={handleDeleteClient}
        onCancel={() => setShowDelete(false)}
      />

      <div className="border-b">
        {(['overview', 'projects', 'tasks', 'notes'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === t ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="rounded-lg border bg-card p-4"><p className="text-xs text-muted-foreground">Total hours</p><p className="text-2xl font-semibold">{totals.total_hours.toFixed(1)}</p></div>
            <div className="rounded-lg border bg-card p-4"><p className="text-xs text-muted-foreground">Active projects</p><p className="text-2xl font-semibold">{activeProjects}</p></div>
            <div className="rounded-lg border bg-card p-4"><p className="text-xs text-muted-foreground">Open tasks</p><p className="text-2xl font-semibold">{openTasks}</p></div>
            {revenue != null && <div className="rounded-lg border bg-card p-4"><p className="text-xs text-muted-foreground">Revenue (ex MVA)</p><p className="text-2xl font-semibold text-emerald-600 dark:text-emerald-400">{formatNOK(revenue)} kr</p></div>}
          </div>

          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-medium">Work log</h2>
              <Button variant="outline" size="sm" onClick={() => setShowAddTime(!showAddTime)}><IconPlus className="size-4 mr-1" />Log time</Button>
            </div>
            {showAddTime && (
              <div className="rounded-lg border bg-card p-4 space-y-3 mb-3">
                <div className="flex gap-2">
                  <input type="text" placeholder="What did you do?" value={timeDesc} onChange={e => setTimeDesc(e.target.value)} className="flex-1 rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" autoFocus />
                  <input type="number" placeholder="Hours" value={timeHours} onChange={e => setTimeHours(e.target.value)} step="0.25" min="0.25" max="24" className="w-24 rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                  <input type="date" value={timeDate} onChange={e => setTimeDate(e.target.value)} className="rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                </div>
                <div className="flex gap-2 justify-end"><Button variant="ghost" size="sm" onClick={() => setShowAddTime(false)}>Cancel</Button><Button size="sm" onClick={handleAddTime} disabled={!timeDesc.trim() || !timeHours}>Log</Button></div>
              </div>
            )}
            {timeEntries.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No time entries yet.</p>
            ) : (
              <div className="rounded-lg border divide-y max-h-[480px] overflow-y-auto">
                {timeEntries.map(e => (
                  <div key={e.id} className="group flex items-center justify-between px-4 py-3">
                    <div><p className="text-sm">{e.description}</p><p className="text-xs text-muted-foreground">{formatDate(e.date)}</p></div>
                    <div className="flex items-center gap-3">
                      <span className="flex items-center gap-1 text-sm font-medium"><IconClock className="size-3.5 text-muted-foreground" />{e.hours.toFixed(1)}h</span>
                      <button
                        onClick={() => setTimeEntryToDelete(e)}
                        aria-label="Delete time entry"
                        className="text-muted-foreground/40 hover:text-destructive transition-colors [@media(hover:hover)]:opacity-0 group-hover:opacity-100 focus:opacity-100"
                      >
                        <IconTrash className="size-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <DeleteTimeEntryDialog
              open={timeEntryToDelete !== null}
              description={timeEntryToDelete?.description ?? ''}
              hours={timeEntryToDelete?.hours ?? 0}
              onConfirm={confirmDeleteTimeEntry}
              onCancel={() => setTimeEntryToDelete(null)}
            />
          </div>
        </div>
      )}

      {tab === 'projects' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">Projects</h2>
            <Button variant="outline" size="sm" onClick={() => setShowAddProject(!showAddProject)}><IconPlus className="size-4 mr-1" />New project</Button>
          </div>
          {showAddProject && (
            <div className="rounded-lg border bg-card p-4 space-y-3">
              <input type="text" placeholder="Project name" value={projectName} onChange={e => setProjectName(e.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" autoFocus />
              <textarea placeholder="Description (optional)" value={projectDesc} onChange={e => setProjectDesc(e.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring min-h-[60px]" />
              <div className="flex gap-2 justify-end"><Button variant="ghost" size="sm" onClick={() => setShowAddProject(false)}>Cancel</Button><Button size="sm" onClick={handleAddProject} disabled={!projectName.trim()}>Create</Button></div>
            </div>
          )}
          {projects.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No projects yet.</p>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {projects.map(p => (
                <Link key={p.id} href={`/clients/${id}/projects/${p.id}`} className="rounded-xl border bg-card p-4 hover:bg-accent/50 transition-colors">
                  <div className="flex items-start justify-between"><h3 className="font-medium">{p.name}</h3><Badge variant="secondary" className={p.status === 'active' ? 'bg-emerald-500/10 text-emerald-700' : ''}>{p.status}</Badge></div>
                  {p.description && <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{p.description}</p>}
                  <div className="flex items-center gap-3 mt-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1"><IconClock className="size-3.5" />{p.total_hours.toFixed(1)}h</span>
                    {p.budget_hours && <span>of {p.budget_hours}h</span>}
                    {p.open_tasks > 0 && <span>{p.open_tasks} open tasks</span>}
                    {p.due_at && <span>Due {formatDate(p.due_at)}</span>}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'tasks' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">Tasks</h2>
            <Button variant="outline" size="sm" onClick={() => setShowAddTask(!showAddTask)}><IconPlus className="size-4 mr-1" />New task</Button>
          </div>
          {showAddTask && (
            <div className="rounded-lg border bg-card p-4 space-y-3">
              <input type="text" placeholder="Task" value={taskTitle} onChange={e => setTaskTitle(e.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" autoFocus />
              <div className="flex gap-2">
                <select value={taskPriority} onChange={e => setTaskPriority(e.target.value)} className="rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring">
                  <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option>
                </select>
                <input type="date" value={taskDue} onChange={e => setTaskDue(e.target.value)} className="rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
              </div>
              <div className="flex gap-2 justify-end"><Button variant="ghost" size="sm" onClick={() => setShowAddTask(false)}>Cancel</Button><Button size="sm" onClick={handleAddTask} disabled={!taskTitle.trim()}>Create</Button></div>
            </div>
          )}
          {tasks.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No tasks yet.</p>
          ) : (
            <div className="rounded-lg border divide-y">
              {tasks.map(t => {
                const isOverdue = t.due_at && t.status !== 'completed' && new Date(t.due_at) < new Date();
                return (
                  <div key={t.id} className="flex items-center gap-3 px-4 py-3">
                    <button onClick={() => toggleTask(t.id, t.status)} className="shrink-0">
                      {t.status === 'completed' ? <IconCircleCheck className="size-5 text-emerald-500" /> : <IconCircle className="size-5 text-muted-foreground" />}
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm ${t.status === 'completed' ? 'line-through text-muted-foreground' : ''}`}>{t.title}</p>
                      <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                        {t.due_at && <span className={isOverdue ? 'text-red-500 font-medium' : ''}>Due {formatDate(t.due_at)}</span>}
                        {t.priority !== 'normal' && <span>{t.priority}</span>}
                      </div>
                    </div>
                    <button
                      onClick={() => setTaskToDelete(t)}
                      aria-label={`Delete task ${t.title}`}
                      className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <IconTrash className="size-4" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <DeleteTaskDialog
            open={taskToDelete !== null}
            taskTitle={taskToDelete?.title ?? ''}
            onConfirm={confirmDeleteTask}
            onCancel={() => setTaskToDelete(null)}
          />
        </div>
      )}

      {tab === 'notes' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">Notes</h2>
            <Button variant="outline" size="sm" onClick={() => setShowAddNote(!showAddNote)}><IconPlus className="size-4 mr-1" />New note</Button>
          </div>
          {showAddNote && (
            <div className="rounded-lg border bg-card p-4 space-y-3">
              <textarea placeholder="Note..." value={noteBody} onChange={e => setNoteBody(e.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring min-h-[100px]" autoFocus />
              <div className="flex gap-2 justify-end"><Button variant="ghost" size="sm" onClick={() => setShowAddNote(false)}>Cancel</Button><Button size="sm" onClick={handleAddNote} disabled={!noteBody.trim()}>Save</Button></div>
            </div>
          )}
          {notes.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No notes yet.</p>
          ) : (
            <div className="space-y-2">
              {notes.map(n => (
                <div key={n.id} className="rounded-lg border bg-card p-4">
                  <p className="text-sm whitespace-pre-wrap">{n.body}</p>
                  <p className="text-xs text-muted-foreground mt-2">{formatDate(n.created_at)}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
