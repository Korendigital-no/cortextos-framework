'use client';

import { useState } from 'react';
import { DndContext, DragOverlay, closestCenter, PointerSensor, useSensor, useSensors, type DragStartEvent, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useDroppable } from '@dnd-kit/core';
import { ScrollArea } from '@/components/ui/scroll-area';
import { StatusBadge } from '@/components/shared';
import { TaskCard } from './task-card';
import type { Task, TaskStatus } from '@/lib/types';

interface KanbanColumn {
  status: TaskStatus;
  label: string;
  tasks: Task[];
}

interface KanbanBoardProps {
  tasks: Task[];
  completedTodayTasks: Task[];
  onTaskClick: (task: Task) => void;
  onStatusChange?: (taskId: string, status: TaskStatus) => void;
}

function DroppableColumn({ status, children }: { status: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <div
      ref={setNodeRef}
      className={`flex flex-col gap-2 transition-colors rounded-lg p-1 ${isOver ? 'bg-accent/30 ring-2 ring-ring/20' : ''}`}
    >
      {children}
    </div>
  );
}

function SortableTaskCard({ task, onClick }: { task: Task; onClick: (task: Task) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id, data: { status: task.status } });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <TaskCard task={task} onClick={onClick} />
    </div>
  );
}

export function KanbanBoard({ tasks, completedTodayTasks, onTaskClick, onStatusChange }: KanbanBoardProps) {
  const [activeTask, setActiveTask] = useState<Task | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const columns: KanbanColumn[] = [
    { status: 'pending', label: 'Pending', tasks: tasks.filter((t) => t.status === 'pending') },
    { status: 'in_progress', label: 'In Progress', tasks: tasks.filter((t) => t.status === 'in_progress') },
    { status: 'blocked', label: 'Blocked', tasks: tasks.filter((t) => t.status === 'blocked') },
    { status: 'completed', label: 'Completed (today)', tasks: completedTodayTasks },
  ];

  const validStatuses = ['pending', 'in_progress', 'blocked', 'completed'] as const;

  function handleDragStart(event: DragStartEvent) {
    const allTasks = [...tasks, ...completedTodayTasks];
    const task = allTasks.find(t => t.id === event.active.id);
    setActiveTask(task ?? null);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveTask(null);
    const { active, over } = event;
    if (!over || !onStatusChange) return;

    const taskId = active.id as string;
    const allTasks = [...tasks, ...completedTodayTasks];
    const task = allTasks.find(t => t.id === taskId);
    if (!task) return;

    let newStatus = over.id as string;
    if (!validStatuses.includes(newStatus as typeof validStatuses[number])) {
      const overTask = allTasks.find(t => t.id === over.id);
      if (overTask) newStatus = overTask.status;
    }

    if (newStatus !== task.status && validStatuses.includes(newStatus as typeof validStatuses[number])) {
      onStatusChange(taskId, newStatus as TaskStatus);
    }
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {columns.map((col) => (
          <div key={col.status} className="flex flex-col gap-2">
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <StatusBadge status={col.status} />
                <span className="text-xs text-muted-foreground">{col.tasks.length}</span>
              </div>
            </div>
            <DroppableColumn status={col.status}>
              <ScrollArea className="h-[calc(100vh-280px)] min-h-[300px]">
                <SortableContext items={col.tasks.map(t => t.id)} strategy={verticalListSortingStrategy}>
                  <div className="flex flex-col gap-2 px-0.5 pt-0.5 pb-1">
                    {col.tasks.length === 0 ? (
                      <p className="px-2 py-8 text-center text-xs text-muted-foreground">
                        Drop tasks here
                      </p>
                    ) : (
                      col.tasks.map((task) => (
                        <SortableTaskCard key={task.id} task={task} onClick={onTaskClick} />
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
        {activeTask ? <TaskCard task={activeTask} onClick={() => {}} /> : null}
      </DragOverlay>
    </DndContext>
  );
}
