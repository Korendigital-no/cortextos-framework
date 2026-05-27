'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  IconArrowLeft, IconMail, IconPhone, IconBuilding,
  IconCalendarEvent, IconNote, IconChecklist, IconVideo,
  IconMailForward, IconPlus,
} from '@tabler/icons-react';

interface Contact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company_id: string | null;
  company_name: string | null;
  company_domain: string | null;
  source: string | null;
  match_confidence: number | null;
  needs_review: number;
  notes: string | null;
  created_at: string;
}

interface Deal {
  id: string;
  title: string;
  value_nok: number | null;
  stage: string;
  created_at: string;
}

interface Activity {
  id: string;
  type: string;
  subject: string | null;
  body: string | null;
  meeting_title: string | null;
  meeting_summary: string | null;
  due_at: string | null;
  completed_at: string | null;
  agent: string | null;
  created_at: string;
}

interface Meeting {
  id: string;
  title: string | null;
  summary: string | null;
  action_items: string | null;
  meeting_start: string | null;
  share_url: string | null;
  email_draft: string | null;
}

const STAGE_COLORS: Record<string, string> = {
  lead: 'bg-blue-500/10 text-blue-700 dark:text-blue-400',
  qualified: 'bg-purple-500/10 text-purple-700 dark:text-purple-400',
  proposal: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  negotiation: 'bg-orange-500/10 text-orange-700 dark:text-orange-400',
  closed_won: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  closed_lost: 'bg-red-500/10 text-red-700 dark:text-red-400',
};

const ACTIVITY_ICONS: Record<string, typeof IconNote> = {
  meeting: IconVideo,
  email: IconMail,
  email_draft: IconMailForward,
  call: IconPhone,
  note: IconNote,
  task: IconChecklist,
  booking: IconCalendarEvent,
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('nb-NO', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatNOK(value: number): string {
  return new Intl.NumberFormat('nb-NO', { style: 'currency', currency: 'NOK', maximumFractionDigits: 0 }).format(value);
}

function confidenceBadge(score: number | null): { label: string; color: string } {
  if (score === null || score >= 0.8) return { label: 'Verified', color: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' };
  if (score >= 0.5) return { label: 'Likely', color: 'bg-amber-500/10 text-amber-700 dark:text-amber-400' };
  return { label: 'Unverified', color: 'bg-red-500/10 text-red-700 dark:text-red-400' };
}

export default function ContactDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [contact, setContact] = useState<Contact | null>(null);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddActivity, setShowAddActivity] = useState(false);
  const [activityType, setActivityType] = useState('note');
  const [activitySubject, setActivitySubject] = useState('');
  const [activityBody, setActivityBody] = useState('');
  const [activityDue, setActivityDue] = useState('');
  const [showAddDeal, setShowAddDeal] = useState(false);
  const [dealTitle, setDealTitle] = useState('');
  const [dealValue, setDealValue] = useState('');

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/crm/contacts/${id}`);
      if (res.ok) {
        const data = await res.json();
        setContact(data.contact);
        setDeals(data.deals);
        setActivities(data.activities);
        setMeetings(data.meetings);
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchData(); }, [fetchData]);

  async function handleAddActivity() {
    if (!activitySubject.trim()) return;
    await fetch('/api/crm/activities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: activityType,
        subject: activitySubject.trim(),
        body: activityBody.trim() || undefined,
        contact_id: id,
        due_at: activityDue || undefined,
      }),
    });
    setActivitySubject('');
    setActivityBody('');
    setActivityDue('');
    setActivityType('note');
    setShowAddActivity(false);
    fetchData();
  }

  async function handleAddDeal() {
    if (!dealTitle.trim()) return;
    await fetch('/api/crm/deals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: dealTitle.trim(),
        value_nok: dealValue ? parseFloat(dealValue) : undefined,
        contact_id: id,
        company_id: contact?.company_id || undefined,
      }),
    });
    setDealTitle('');
    setDealValue('');
    setShowAddDeal(false);
    fetchData();
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 rounded bg-muted/30 animate-pulse" />
        <div className="h-32 rounded-lg bg-muted/30 animate-pulse" />
        <div className="h-64 rounded-lg bg-muted/30 animate-pulse" />
      </div>
    );
  }

  if (!contact) {
    return (
      <div className="space-y-4">
        <Link href="/crm/contacts"><Button variant="ghost" size="sm"><IconArrowLeft className="size-4 mr-1" />Back</Button></Link>
        <p className="text-sm text-muted-foreground">Contact not found.</p>
      </div>
    );
  }

  const conf = confidenceBadge(contact.match_confidence);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Link href="/crm/contacts">
            <Button variant="ghost" size="icon-sm"><IconArrowLeft className="size-4" /></Button>
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold">{contact.name}</h1>
              <Badge variant="secondary" className={conf.color}>{conf.label}</Badge>
              {contact.needs_review === 1 && <Badge variant="destructive">Needs Review</Badge>}
            </div>
            <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
              {contact.email && <span className="flex items-center gap-1"><IconMail className="size-3.5" />{contact.email}</span>}
              {contact.phone && <span className="flex items-center gap-1"><IconPhone className="size-3.5" />{contact.phone}</span>}
              {contact.company_name && <span className="flex items-center gap-1"><IconBuilding className="size-3.5" />{contact.company_name}</span>}
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => { setShowAddActivity(!showAddActivity); setShowAddDeal(false); }}>
            <IconPlus className="size-4 mr-1" />Activity
          </Button>
          <Button variant="outline" size="sm" onClick={() => { setShowAddDeal(!showAddDeal); setShowAddActivity(false); }}>
            <IconPlus className="size-4 mr-1" />Deal
          </Button>
        </div>
      </div>

      {showAddActivity && (
        <div className="rounded-lg border bg-card p-4 space-y-3">
          <div className="flex gap-2">
            <select value={activityType} onChange={e => setActivityType(e.target.value)}
              className="rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring">
              <option value="note">Note</option>
              <option value="call">Call</option>
              <option value="email">Email</option>
              <option value="meeting">Meeting</option>
              <option value="task">Task</option>
            </select>
            <input type="text" placeholder="Subject" value={activitySubject} onChange={e => setActivitySubject(e.target.value)}
              className="flex-1 rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" autoFocus />
          </div>
          <textarea placeholder="Details (optional)" value={activityBody} onChange={e => setActivityBody(e.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring min-h-[60px]" />
          {activityType === 'task' && (
            <input type="date" value={activityDue} onChange={e => setActivityDue(e.target.value)}
              className="rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
          )}
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={() => setShowAddActivity(false)}>Cancel</Button>
            <Button size="sm" onClick={handleAddActivity} disabled={!activitySubject.trim()}>Save</Button>
          </div>
        </div>
      )}

      {showAddDeal && (
        <div className="rounded-lg border bg-card p-4 space-y-3">
          <div className="flex gap-2">
            <input type="text" placeholder="Deal title" value={dealTitle} onChange={e => setDealTitle(e.target.value)}
              className="flex-1 rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" autoFocus />
            <input type="number" placeholder="Value (NOK)" value={dealValue} onChange={e => setDealValue(e.target.value)}
              className="w-32 rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={() => setShowAddDeal(false)}>Cancel</Button>
            <Button size="sm" onClick={handleAddDeal} disabled={!dealTitle.trim()}>Create Deal</Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Activity Timeline */}
        <div className="lg:col-span-2 space-y-4">
          <h2 className="text-lg font-medium">Activity Timeline</h2>
          {activities.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No activity yet.</p>
          ) : (
            <div className="space-y-3">
              {activities.map(activity => {
                const Icon = ACTIVITY_ICONS[activity.type] ?? IconNote;
                const isOverdue = activity.type === 'task' && activity.due_at && !activity.completed_at && new Date(activity.due_at) < new Date();
                return (
                  <div key={activity.id} className="flex gap-3 rounded-lg border bg-card p-3">
                    <div className="shrink-0 mt-0.5">
                      <Icon className={`size-4 ${isOverdue ? 'text-red-500' : 'text-muted-foreground'}`} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium truncate">{activity.subject ?? activity.type}</p>
                        <span className="text-xs text-muted-foreground shrink-0">{formatDate(activity.created_at)}</span>
                      </div>
                      {activity.body && (
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{activity.body}</p>
                      )}
                      {activity.meeting_summary && (
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-3">{activity.meeting_summary}</p>
                      )}
                      {activity.due_at && (
                        <p className={`text-xs mt-1 ${isOverdue ? 'text-red-500 font-medium' : 'text-muted-foreground'}`}>
                          Due: {formatDate(activity.due_at)}{isOverdue ? ' (overdue)' : ''}
                        </p>
                      )}
                      {activity.agent && (
                        <p className="text-xs text-muted-foreground mt-0.5">by {activity.agent}</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Deals */}
          <div>
            <h3 className="text-sm font-medium mb-2">Deals</h3>
            {deals.length === 0 ? (
              <p className="text-xs text-muted-foreground">No deals.</p>
            ) : (
              <div className="space-y-2">
                {deals.map(deal => (
                  <div key={deal.id} className="rounded-lg border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium truncate">{deal.title}</p>
                      <Badge variant="secondary" className={STAGE_COLORS[deal.stage] ?? ''}>
                        {deal.stage}
                      </Badge>
                    </div>
                    {deal.value_nok != null && (
                      <p className="text-sm text-emerald-600 dark:text-emerald-400 mt-1">{formatNOK(deal.value_nok)}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Meetings */}
          <div>
            <h3 className="text-sm font-medium mb-2">Meetings</h3>
            {meetings.length === 0 ? (
              <p className="text-xs text-muted-foreground">No meetings.</p>
            ) : (
              <div className="space-y-2">
                {meetings.map(meeting => (
                  <div key={meeting.id} className="rounded-lg border p-3">
                    <p className="text-sm font-medium">{meeting.title ?? 'Meeting'}</p>
                    {meeting.meeting_start && (
                      <p className="text-xs text-muted-foreground">{formatDate(meeting.meeting_start)}</p>
                    )}
                    {meeting.summary && (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-3">{meeting.summary}</p>
                    )}
                    {meeting.share_url && (
                      <a href={meeting.share_url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-500 hover:underline mt-1 block">
                        View recording
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Contact Info */}
          <div>
            <h3 className="text-sm font-medium mb-2">Details</h3>
            <div className="rounded-lg border p-3 space-y-1 text-xs text-muted-foreground">
              <p>Source: {contact.source ?? 'Unknown'}</p>
              <p>Confidence: {contact.match_confidence != null ? `${Math.round(contact.match_confidence * 100)}%` : '100%'}</p>
              <p>Added: {formatDate(contact.created_at)}</p>
              {contact.notes && <p className="mt-2">{contact.notes}</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
