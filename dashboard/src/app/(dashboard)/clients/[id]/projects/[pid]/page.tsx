'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { IconArrowLeft, IconClock, IconPlus, IconCircle, IconCircleCheck, IconChecklist } from '@tabler/icons-react';

type Tab = 'time' | 'tasks' | 'notes' | 'checklists';

interface Project {
  id: string; name: string; description: string | null;
  status: string; started_at: string | null; due_at: string | null;
  budget_hours: number | null; budget_nok: number | null;
  billable: number;
}

interface TimeEntry { id: string; description: string; hours: number; date: string; project_id: string | null; billable: number | null; }
interface SiblingProject { id: string; name: string; }
interface Task { id: string; title: string; status: string; priority: string; due_at: string | null; }
interface Note { id: string; body: string; created_at: string; }
interface ChecklistItem { id: string; text: string; done: number; position: number; }
interface Checklist { id: string; title: string; items: ChecklistItem[]; }

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('nb-NO', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function ProjectDetailPage() {
  const { id, pid } = useParams<{ id: string; pid: string }>();
  const [tab, setTab] = useState<Tab>('time');
  const [project, setProject] = useState<Project | null>(null);
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [totals, setTotals] = useState({ total_hours: 0, entry_count: 0, billable_hours: 0, non_billable_hours: 0 });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const [showAddTime, setShowAddTime] = useState(false);
  const [timeDesc, setTimeDesc] = useState('');
  const [timeHours, setTimeHours] = useState('');
  const [timeDate, setTimeDate] = useState(new Date().toISOString().split('T')[0]);
  const [timeBillable, setTimeBillable] = useState(true);

  // Sibling projects (same client) for the "move entry" dropdown.
  const [siblingProjects, setSiblingProjects] = useState<SiblingProject[]>([]);
  // Inline edit/move state for a single time entry.
  const [editEntryId, setEditEntryId] = useState<string | null>(null);
  const [editDesc, setEditDesc] = useState('');
  const [editHours, setEditHours] = useState('');
  const [editDate, setEditDate] = useState('');
  const [editProjectId, setEditProjectId] = useState<string>('');
  const [editBillable, setEditBillable] = useState<'inherit' | 'yes' | 'no'>('inherit');

  const [showAddTask, setShowAddTask] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDue, setTaskDue] = useState('');

  const [showAddNote, setShowAddNote] = useState(false);
  const [noteBody, setNoteBody] = useState('');

  const [showAddChecklist, setShowAddChecklist] = useState(false);
  const [checklistTitle, setChecklistTitle] = useState('');
  const [checklistItems, setChecklistItems] = useState('');

  const fetchAll = useCallback(async () => {
    try {
      const [pRes, clRes, projRes] = await Promise.all([
        fetch(`/api/clients/${id}/projects/${pid}`),
        fetch(`/api/clients/${id}/checklists?project=${pid}`),
        fetch(`/api/clients/${id}/projects`),
      ]);
      if (pRes.ok) {
        const data = await pRes.json();
        setProject(data.project);
        setTimeEntries(data.timeEntries);
        setTasks(data.tasks);
        setNotes(data.notes);
        setTotals(data.totals);
        setLoadError(false);
      } else {
        // A 404 means the project genuinely does not belong to this client.
        // Any other status (e.g. a 500 from a server-side query error) must NOT
        // masquerade as "not found" — surface it as a load error so the real
        // failure is visible instead of a misleading empty state.
        setLoadError(pRes.status !== 404);
      }
      if (clRes.ok) setChecklists(await clRes.json());
      if (projRes.ok) {
        const projects = await projRes.json();
        setSiblingProjects((Array.isArray(projects) ? projects : []).map((p: SiblingProject) => ({ id: p.id, name: p.name })));
      }
    } catch {
      setLoadError(true);
    } finally { setLoading(false); }
  }, [id, pid]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // The project's billable default (true unless explicitly set non-billable).
  const projectBillableDefault = project ? project.billable !== 0 : true;

  function openAddTime() {
    // Initialise the checkbox from the project default so logging on a
    // non-billable project doesn't silently mark the entry billable.
    setTimeBillable(projectBillableDefault);
    setShowAddTime(s => !s);
  }

  async function handleAddTime() {
    if (!timeDesc.trim() || !timeHours) return;
    // Only store an explicit override when the choice differs from the project
    // default; otherwise send null so the entry inherits (honours billable.ts).
    const billable = timeBillable === projectBillableDefault ? null : timeBillable ? 1 : 0;
    await fetch(`/api/clients/${id}/time-entries`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: timeDesc.trim(), hours: parseFloat(timeHours), date: timeDate, project_id: pid, billable }),
    });
    setTimeDesc(''); setTimeHours(''); setTimeDate(new Date().toISOString().split('T')[0]); setTimeBillable(projectBillableDefault); setShowAddTime(false);
    fetchAll();
  }

  function beginEditEntry(e: TimeEntry) {
    setEditEntryId(e.id);
    setEditDesc(e.description);
    setEditHours(String(e.hours));
    setEditDate(e.date.split('T')[0]);
    setEditProjectId(e.project_id ?? '');
    setEditBillable(e.billable === null || e.billable === undefined ? 'inherit' : e.billable === 1 ? 'yes' : 'no');
  }

  async function handleSaveEntry() {
    if (!editEntryId || !editDesc.trim() || !editHours) return;
    const billable = editBillable === 'inherit' ? null : editBillable === 'yes' ? 1 : 0;
    await fetch(`/api/clients/${id}/time-entries/${editEntryId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: editDesc.trim(), hours: parseFloat(editHours), date: editDate,
        project_id: editProjectId || null, billable,
      }),
    });
    setEditEntryId(null);
    fetchAll();
  }

  async function handleDeleteEntry(entryId: string) {
    await fetch(`/api/clients/${id}/time-entries/${entryId}`, { method: 'DELETE' });
    setEditEntryId(null);
    fetchAll();
  }

  async function handleAddTask() {
    if (!taskTitle.trim()) return;
    await fetch(`/api/clients/${id}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: taskTitle.trim(), due_at: taskDue || undefined, project_id: pid }),
    });
    setTaskTitle(''); setTaskDue(''); setShowAddTask(false);
    fetchAll();
  }

  async function handleAddNote() {
    if (!noteBody.trim()) return;
    await fetch(`/api/clients/${id}/notes`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: noteBody.trim(), project_id: pid }),
    });
    setNoteBody(''); setShowAddNote(false);
    fetchAll();
  }

  async function handleAddChecklist() {
    if (!checklistTitle.trim()) return;
    const items = checklistItems.split('\n').map(s => s.trim()).filter(Boolean);
    await fetch(`/api/clients/${id}/checklists`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: checklistTitle.trim(), project_id: pid, items }),
    });
    setChecklistTitle(''); setChecklistItems(''); setShowAddChecklist(false);
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

  async function toggleChecklistItem(clid: string, itemId: string, currentDone: number) {
    await fetch(`/api/clients/${id}/checklists/${clid}/items`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: itemId, done: !currentDone }),
    });
    fetchAll();
  }

  if (loading) return <div className="space-y-4"><div className="h-8 w-48 rounded bg-muted/30 animate-pulse" /><div className="h-64 rounded-lg bg-muted/30 animate-pulse" /></div>;
  if (!project) return (
    <div className="space-y-4">
      <Link href={`/clients/${id}`}><Button variant="ghost" size="sm"><IconArrowLeft className="size-4 mr-1" />Back</Button></Link>
      {loadError ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">Could not load this project. Something went wrong on our end.</p>
          <Button variant="outline" size="sm" onClick={() => { setLoading(true); fetchAll(); }}>Try again</Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Project not found.</p>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href={`/clients/${id}`}><Button variant="ghost" size="icon-sm"><IconArrowLeft className="size-4" /></Button></Link>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{project.name}</h1>
            <Badge variant="secondary" className={project.status === 'active' ? 'bg-emerald-500/10 text-emerald-700' : ''}>{project.status}</Badge>
          </div>
          <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground">
            <span className="flex items-center gap-1"><IconClock className="size-3.5" />{totals.total_hours.toFixed(1)}h</span>
            {project.budget_hours && <span>of {project.budget_hours}h budgeted</span>}
            {totals.total_hours > 0 && <span>{totals.billable_hours.toFixed(1)}h billable / {totals.non_billable_hours.toFixed(1)}h non-billable</span>}
            {project.due_at && <span>Due {formatDate(project.due_at)}</span>}
          </div>
          {project.description && <p className="text-sm text-muted-foreground mt-2 max-w-2xl">{project.description}</p>}
        </div>
      </div>

      <div className="border-b">
        {(['time', 'tasks', 'notes', 'checklists'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === t ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'time' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">Time entries</h2>
            <Button variant="outline" size="sm" onClick={openAddTime}><IconPlus className="size-4 mr-1" />Log time</Button>
          </div>
          {showAddTime && (
            <div className="rounded-lg border bg-card p-4 space-y-3">
              <div className="flex gap-2">
                <input type="text" placeholder="What did you do?" value={timeDesc} onChange={e => setTimeDesc(e.target.value)} className="flex-1 rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" autoFocus />
                <input type="number" placeholder="Hours" value={timeHours} onChange={e => setTimeHours(e.target.value)} step="0.25" min="0.25" max="24" className="w-24 rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                <input type="date" value={timeDate} onChange={e => setTimeDate(e.target.value)} className="rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
              </div>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input type="checkbox" checked={timeBillable} onChange={e => setTimeBillable(e.target.checked)} className="size-4" />
                Billable
              </label>
              <div className="flex gap-2 justify-end"><Button variant="ghost" size="sm" onClick={() => setShowAddTime(false)}>Cancel</Button><Button size="sm" onClick={handleAddTime} disabled={!timeDesc.trim() || !timeHours}>Log</Button></div>
            </div>
          )}
          {timeEntries.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No time logged on this project.</p> : (
            <div className="rounded-lg border divide-y">
              {timeEntries.map(e => editEntryId === e.id ? (
                <div key={e.id} className="px-4 py-3 space-y-3 bg-muted/20">
                  <div className="flex gap-2">
                    <input type="text" value={editDesc} onChange={ev => setEditDesc(ev.target.value)} className="flex-1 rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                    <input type="number" value={editHours} onChange={ev => setEditHours(ev.target.value)} step="0.25" min="0.25" max="24" className="w-24 rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                    <input type="date" value={editDate} onChange={ev => setEditDate(ev.target.value)} className="rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                  </div>
                  <div className="flex gap-2 flex-wrap items-center">
                    <label className="text-xs text-muted-foreground">Project
                      <select value={editProjectId} onChange={ev => setEditProjectId(ev.target.value)} className="ml-2 rounded-md border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring">
                        <option value="">— Client-level (no project) —</option>
                        {siblingProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    </label>
                    <label className="text-xs text-muted-foreground">Billable
                      <select value={editBillable} onChange={ev => setEditBillable(ev.target.value as 'inherit' | 'yes' | 'no')} className="ml-2 rounded-md border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring">
                        <option value="inherit">Inherit project default</option>
                        <option value="yes">Billable</option>
                        <option value="no">Non-billable</option>
                      </select>
                    </label>
                  </div>
                  <div className="flex gap-2 justify-between">
                    <Button variant="ghost" size="sm" className="text-red-500 hover:text-red-600" onClick={() => handleDeleteEntry(e.id)}>Delete</Button>
                    <div className="flex gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setEditEntryId(null)}>Cancel</Button>
                      <Button size="sm" onClick={handleSaveEntry} disabled={!editDesc.trim() || !editHours}>Save</Button>
                    </div>
                  </div>
                </div>
              ) : (
                <div key={e.id} className="flex items-center justify-between px-4 py-3 group">
                  <div>
                    <p className="text-sm">{e.description}</p>
                    <p className="text-xs text-muted-foreground">{formatDate(e.date)}{e.billable === 0 ? ' · non-billable' : e.billable === 1 ? ' · billable' : ''}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="flex items-center gap-1 text-sm font-medium"><IconClock className="size-3.5 text-muted-foreground" />{e.hours.toFixed(1)}h</span>
                    <Button variant="ghost" size="sm" className="opacity-0 group-hover:opacity-100 transition-opacity" onClick={() => beginEditEntry(e)}>Edit</Button>
                  </div>
                </div>
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
              <input type="date" value={taskDue} onChange={e => setTaskDue(e.target.value)} className="rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
              <div className="flex gap-2 justify-end"><Button variant="ghost" size="sm" onClick={() => setShowAddTask(false)}>Cancel</Button><Button size="sm" onClick={handleAddTask} disabled={!taskTitle.trim()}>Create</Button></div>
            </div>
          )}
          {tasks.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No tasks yet.</p> : (
            <div className="rounded-lg border divide-y">
              {tasks.map(t => {
                const isOverdue = t.due_at && t.status !== 'completed' && new Date(t.due_at) < new Date();
                return (
                  <div key={t.id} className="flex items-center gap-3 px-4 py-3">
                    <button onClick={() => toggleTask(t.id, t.status)} className="shrink-0">
                      {t.status === 'completed' ? <IconCircleCheck className="size-5 text-emerald-500" /> : <IconCircle className="size-5 text-muted-foreground" />}
                    </button>
                    <div className="flex-1"><p className={`text-sm ${t.status === 'completed' ? 'line-through text-muted-foreground' : ''}`}>{t.title}</p>{t.due_at && <p className={`text-xs ${isOverdue ? 'text-red-500 font-medium' : 'text-muted-foreground'}`}>Due {formatDate(t.due_at)}</p>}</div>
                  </div>
                );
              })}
            </div>
          )}
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
          {notes.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No notes yet.</p> : (
            <div className="space-y-2">
              {notes.map(n => (
                <div key={n.id} className="rounded-lg border bg-card p-4"><p className="text-sm whitespace-pre-wrap">{n.body}</p><p className="text-xs text-muted-foreground mt-2">{formatDate(n.created_at)}</p></div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'checklists' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">Checklists</h2>
            <Button variant="outline" size="sm" onClick={() => setShowAddChecklist(!showAddChecklist)}><IconPlus className="size-4 mr-1" />New checklist</Button>
          </div>
          {showAddChecklist && (
            <div className="rounded-lg border bg-card p-4 space-y-3">
              <input type="text" placeholder="Checklist title" value={checklistTitle} onChange={e => setChecklistTitle(e.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" autoFocus />
              <textarea placeholder="One item per line" value={checklistItems} onChange={e => setChecklistItems(e.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring min-h-[120px]" />
              <div className="flex gap-2 justify-end"><Button variant="ghost" size="sm" onClick={() => setShowAddChecklist(false)}>Cancel</Button><Button size="sm" onClick={handleAddChecklist} disabled={!checklistTitle.trim()}>Create</Button></div>
            </div>
          )}
          {checklists.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No checklists yet.</p> : (
            <div className="space-y-3">
              {checklists.map(cl => (
                <div key={cl.id} className="rounded-lg border bg-card p-4">
                  <h3 className="font-medium mb-2">{cl.title}</h3>
                  <div className="space-y-1">
                    {cl.items.map(it => (
                      <button key={it.id} onClick={() => toggleChecklistItem(cl.id, it.id, it.done)} className="flex items-center gap-2 w-full text-left hover:bg-accent/50 rounded px-2 py-1">
                        {it.done ? <IconCircleCheck className="size-4 text-emerald-500 shrink-0" /> : <IconCircle className="size-4 text-muted-foreground shrink-0" />}
                        <span className={`text-sm ${it.done ? 'line-through text-muted-foreground' : ''}`}>{it.text}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
