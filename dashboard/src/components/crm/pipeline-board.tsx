'use client';

import { useState } from 'react';
import { DndContext, DragOverlay, closestCenter, PointerSensor, useSensor, useSensors, type DragStartEvent, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useDroppable } from '@dnd-kit/core';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { DealCard } from './deal-card';

interface Deal {
  id: string;
  title: string;
  value_nok: number | null;
  stage: string;
  contact_name?: string;
  company_name?: string;
  created_at: string;
  updated_at: string;
}

const STAGE_CONFIG: Record<string, { label: string; color: string }> = {
  lead: { label: 'Lead', color: 'bg-blue-500/10 text-blue-700 dark:text-blue-400' },
  qualified: { label: 'Qualified', color: 'bg-purple-500/10 text-purple-700 dark:text-purple-400' },
  proposal: { label: 'Proposal', color: 'bg-amber-500/10 text-amber-700 dark:text-amber-400' },
  negotiation: { label: 'Negotiation', color: 'bg-orange-500/10 text-orange-700 dark:text-orange-400' },
};

function formatNOK(value: number): string {
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(0)}k`;
  return String(value);
}

function DroppableColumn({ stage, children }: { stage: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  return (
    <div
      ref={setNodeRef}
      className={`flex flex-col gap-2 transition-colors rounded-lg p-1 ${isOver ? 'bg-accent/30 ring-2 ring-ring/20' : ''}`}
    >
      {children}
    </div>
  );
}

function SortableDealCard({ deal, onClick }: { deal: Deal; onClick?: (deal: Deal) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: deal.id, data: { stage: deal.stage } });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <DealCard deal={deal} onClick={onClick} />
    </div>
  );
}

interface PipelineBoardProps {
  deals: Deal[];
  onDealClick?: (deal: Deal) => void;
  onStageChange?: (dealId: string, newStage: string) => void;
}

export function PipelineBoard({ deals, onDealClick, onStageChange }: PipelineBoardProps) {
  const stages = ['lead', 'qualified', 'proposal', 'negotiation'];
  const [activeDeal, setActiveDeal] = useState<Deal | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  function handleDragStart(event: DragStartEvent) {
    const deal = deals.find(d => d.id === event.active.id);
    setActiveDeal(deal ?? null);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDeal(null);
    const { active, over } = event;
    if (!over) return;

    const dealId = active.id as string;
    const deal = deals.find(d => d.id === dealId);
    if (!deal) return;

    let newStage = over.id as string;
    if (!stages.includes(newStage)) {
      const overDeal = deals.find(d => d.id === over.id);
      if (overDeal) newStage = overDeal.stage;
    }

    if (newStage !== deal.stage && stages.includes(newStage)) {
      onStageChange?.(dealId, newStage);
    }
  }

  const columns = stages.map(stage => {
    const stageDeals = deals.filter(d => d.stage === stage);
    return {
      stage,
      label: STAGE_CONFIG[stage]?.label ?? stage,
      deals: stageDeals,
      totalValue: stageDeals.reduce((sum, d) => sum + (d.value_nok ?? 0), 0),
    };
  });

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {columns.map(col => (
          <div key={col.stage} className="flex flex-col gap-2">
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className={STAGE_CONFIG[col.stage]?.color}>
                  {col.label}
                </Badge>
                <span className="text-xs text-muted-foreground">{col.deals.length}</span>
              </div>
              {col.totalValue > 0 && (
                <span className="text-xs font-medium text-muted-foreground">
                  {formatNOK(col.totalValue)} NOK
                </span>
              )}
            </div>
            <DroppableColumn stage={col.stage}>
              <ScrollArea className="h-[calc(100vh-280px)] min-h-[300px]">
                <SortableContext items={col.deals.map(d => d.id)} strategy={verticalListSortingStrategy}>
                  <div className="flex flex-col gap-2 px-0.5 pt-0.5 pb-1">
                    {col.deals.length === 0 ? (
                      <p className="px-2 py-8 text-center text-xs text-muted-foreground">
                        Drop deals here
                      </p>
                    ) : (
                      col.deals.map(deal => (
                        <SortableDealCard key={deal.id} deal={deal} onClick={onDealClick} />
                      ))
                    )}
                  </div>
                </SortableContext>
              </ScrollArea>
            </DroppableColumn>
          </div>
        ))}
      </div>
      <DragOverlay>
        {activeDeal ? <DealCard deal={activeDeal} /> : null}
      </DragOverlay>
    </DndContext>
  );
}
