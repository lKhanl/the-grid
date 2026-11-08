import { useState } from 'react'
import type { Action, Info, State } from './api'
import { ChevronIcon, EditIcon, PlayIcon, PlusIcon, RestartIcon, StopIcon } from './icons'
import { ACTIVE, Btn, StatusIcon, statusLabel, uptime } from './ui'

interface Props {
  state: State | null
  /** services by group, in file order ('' = no group) */
  groups: [string, Info[]][]
  collapsed: Set<string>
  toggleGroup: (group: string) => void
  selected: string | null
  setSelected: (name: string) => void
  /** services with output the user has not seen yet */
  unread: Record<string, 'out' | 'err'>
  run: (target: string, action: Action) => void
  /** open the service form: a new service (in a group) or an existing one */
  onNew: (group?: string) => void
  onEdit: (name: string) => void
  onMenu: (x: number, y: number, service: string) => void
  /** saves a new order of all services */
  onReorder: (names: string[]) => void
}

/** Services panel in the sidebar: groups and rows, drag & drop to reorder. */
export function ServiceList({ state, groups, collapsed, toggleGroup, selected, setSelected, unread, run, onNew, onEdit, onMenu, onReorder }: Props) {
  // drag & drop reordering inside a group
  const [drag, setDrag] = useState<{ name: string; group: string } | null>(null)
  const [dropAt, setDropAt] = useState<{ name: string; after: boolean } | null>(null)
  const [dragGroup, setDragGroup] = useState<string | null>(null)
  const [groupDropAt, setGroupDropAt] = useState<{ group: string; after: boolean } | null>(null)
  const services = state?.services ?? []

  /** Move a whole group before/after another one; services keep their group. */
  function moveGroup(name: string, target: string, after: boolean) {
    if (name === target) return
    const order = groups.map(([g]) => g).filter((g) => g !== name)
    order.splice(order.indexOf(target) + (after ? 1 : 0), 0, name)
    onReorder(order.flatMap((g) => groups.find(([x]) => x === g)![1].map((s) => s.name)))
  }

  const endDrag = () => {
    setDrag(null)
    setDropAt(null)
    setDragGroup(null)
    setGroupDropAt(null)
  }

  /** Move `name` before/after `target` (same group) and save the order. */
  function moveService(name: string, target: string, after: boolean) {
    if (!state || name === target) return
    const all = state.services.map((s) => s.name)
    const group = state.services.find((s) => s.name === name)?.group ?? ''
    const slots = state.services.flatMap((s, i) => ((s.group ?? '') === group ? [i] : []))
    const members = slots.map((i) => all[i]).filter((n) => n !== name)
    const at = members.indexOf(target) + (after ? 1 : 0)
    members.splice(at, 0, name)
    const next = [...all]
    slots.forEach((i, k) => (next[i] = members[k]))
    onReorder(next)
  }

  return (
    <>
      <div className="sidebar-head divided">
        <span>Services</span>
        <Btn icon={<PlusIcon size={14} />} label="New" title="New service (N)" kind="text small" onClick={() => onNew()} />
      </div>
      {groups.map(([group, list]) => (
        <div
          key={group}
          className={`group ${dragGroup === group ? 'dragging' : ''} ${
            groupDropAt?.group === group && dragGroup !== group ? (groupDropAt.after ? 'drop-after' : 'drop-before') : ''
          }`}
          onDragOver={(e) => {
            if (dragGroup === null) return // a service is being dragged: rows handle it
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            const r = e.currentTarget.getBoundingClientRect()
            const after = e.clientY > r.top + r.height / 2
            if (groupDropAt?.group !== group || groupDropAt.after !== after) setGroupDropAt({ group, after })
          }}
          onDrop={(e) => {
            if (dragGroup === null) return
            e.preventDefault()
            if (groupDropAt) moveGroup(dragGroup, groupDropAt.group, groupDropAt.after)
            endDrag()
          }}
        >
          {group && (
            <div
              className="group-head"
              draggable
              title="Click to collapse or expand, drag to reorder"
              onClick={() => toggleGroup(group)}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', 'group:' + group)
                setDragGroup(group)
              }}
              onDragEnd={endDrag}
            >
              <span className={`group-chevron ${collapsed.has(group) ? '' : 'open'}`}>
                <ChevronIcon size={13} />
              </span>
              <span className="group-name">{group}</span>
              {collapsed.has(group) && (
                <span className="group-count">
                  {list.some((s) => ACTIVE.has(s.status)) && <span className="dot dot-running" />}
                  {list.filter((s) => s.status === 'running').length}/{list.length}
                  {list.some((s) => s.status === 'crashed') && <span className="group-crashed">!</span>}
                </span>
              )}
              <span className="row-actions">
                <Btn icon={<PlusIcon size={14} />} title={`New service in ${group}`} onClick={() => onNew(group)} />
                <Btn icon={<PlayIcon size={14} />} title={`Start ${group}`} onClick={() => run(group, 'start')} kind="green" />
                <Btn icon={<StopIcon size={14} />} title={`Stop ${group}`} onClick={() => run(group, 'stop')} kind="red" />
              </span>
            </div>
          )}
          {!(group && collapsed.has(group)) && list.map((s) => {
            const active = ACTIVE.has(s.status)
            return (
              <div
                key={s.name}
                className={`row ${s.name === selected ? 'selected' : ''} ${group ? 'indent' : ''} ${drag?.name === s.name ? 'dragging' : ''} ${
                  dropAt?.name === s.name && drag?.name !== s.name ? (dropAt.after ? 'drop-after' : 'drop-before') : ''
                }`}
                onClick={() => setSelected(s.name)}
                onDoubleClick={() => run(s.name, active ? 'restart' : 'start')}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', s.name)
                  setDrag({ name: s.name, group })
                }}
                onDragOver={(e) => {
                  if (!drag || drag.group !== group) return // only within the same group
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  const r = e.currentTarget.getBoundingClientRect()
                  const after = e.clientY > r.top + r.height / 2
                  if (dropAt?.name !== s.name || dropAt.after !== after) setDropAt({ name: s.name, after })
                }}
                onDrop={(e) => {
                  if (!drag) return // a group is being dragged: let the group handle it
                  e.preventDefault()
                  e.stopPropagation()
                  if (dropAt) moveService(drag.name, dropAt.name, dropAt.after)
                  endDrag()
                }}
                onDragEnd={endDrag}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setSelected(s.name)
                  onMenu(e.clientX, e.clientY, s.name)
                }}
                title={s.description || s.command}
              >
                <StatusIcon status={s.status} type={s.type} />
                <span className="name">{s.name}</span>
                {unread[s.name] && <span className={`unread unread-${unread[s.name]}`} />}
                <span className="meta">
                  {s.status === 'running'
                    ? uptime(s.startedAt)
                    : s.status === 'starting' || s.status === 'building'
                      ? `${s.status} ${s.startedAt ? uptime(s.startedAt) : '…'}`
                      : s.status === 'stopped'
                        ? ''
                        : statusLabel(s)}
                </span>
                <span className="row-actions">
                  {active ? (
                    <Btn icon={<StopIcon size={14} />} title="Stop" onClick={() => run(s.name, 'stop')} kind="red" />
                  ) : (
                    <Btn icon={<PlayIcon size={14} />} title="Start" onClick={() => run(s.name, 'start')} kind="green" />
                  )}
                  <Btn icon={<RestartIcon size={14} />} title="Restart" onClick={() => run(s.name, 'restart')} />
                  <Btn icon={<EditIcon size={14} />} title="Edit (e)" onClick={() => onEdit(s.name)} />
                </span>
              </div>
            )
          })}
        </div>
      ))}
      {state && state.configPath !== '' && services.length === 0 && (
        <div className="empty">
          No services yet.
          <Btn icon={<PlusIcon size={14} />} label="Add your first service" title="New service" kind="text" onClick={() => onNew()} />
        </div>
      )}
    </>
  )
}
