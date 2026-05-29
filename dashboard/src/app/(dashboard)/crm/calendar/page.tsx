'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { IconArrowLeft, IconCalendar } from '@tabler/icons-react';

export default function CalendarPage() {
  const calendarSrc = process.env.NEXT_PUBLIC_GCAL_EMBED_URL;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/crm">
          <Button variant="ghost" size="icon-sm">
            <IconArrowLeft className="size-4" />
          </Button>
        </Link>
        <h1 className="text-2xl font-semibold">Calendar</h1>
      </div>

      {calendarSrc ? (
        <div className="rounded-lg border bg-card overflow-hidden" style={{ height: 'calc(100vh - 180px)' }}>
          <iframe
            src={calendarSrc}
            className="w-full h-full border-0"
            title="Google Calendar"
          />
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <IconCalendar size={48} className="text-muted-foreground/30 mb-4" />
          <h3 className="text-lg font-medium mb-1">Calendar not configured</h3>
          <p className="text-sm text-muted-foreground max-w-sm">
            Add NEXT_PUBLIC_GCAL_EMBED_URL to dashboard/.env.local with your Google Calendar embed URL.
          </p>
        </div>
      )}
    </div>
  );
}
