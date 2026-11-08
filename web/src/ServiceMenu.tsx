import { deleteService, type Action, type State } from './api'
import { ContextMenu, type MenuEntry } from './ContextMenu'
import { ClearIcon, EditIcon, ExternalIcon, PlayIcon, RestartIcon, StopIcon, TerminalIcon, TrashIcon } from './icons'
import { ACTIVE, BUILDS } from './ui'

interface Props {
  state: State
  service: string
  x: number
  y: number
  run: (target: string, action: Action) => void
  onEdit: (name: string) => void
  onTerminal: (service: string) => void
  onDeleted: (name: string) => void
  setError: (e: string) => void
  onClose: () => void
}

/** Right-click menu of a service row. */
export function ServiceMenu({ state, service, x, y, run, onEdit, onTerminal, onDeleted, setError, onClose }: Props) {
  const s = state.services.find((x) => x.name === service)
  if (!s) return null
  const active = ACTIVE.has(s.status)
  const dependents = state.services.filter((x) => x.dependsOn?.includes(s.name)).map((x) => x.name)
  const items: MenuEntry[] = [
    active
      ? { label: 'Stop (derezz)', icon: <StopIcon size={14} />, hint: 'S', kind: 'red', onSelect: () => run(s.name, 'stop') }
      : { label: 'Start', icon: <PlayIcon size={14} />, hint: 'S', kind: 'green', onSelect: () => run(s.name, 'start') },
    ...(!active && BUILDS.has(s.type)
      ? [{ label: 'Run without build', icon: <PlayIcon size={14} />, onSelect: () => run(s.name, 'start-nobuild') }]
      : []),
    { label: 'Restart', icon: <RestartIcon size={14} />, hint: 'R', onSelect: () => run(s.name, 'restart') },
    { label: 'Clear log', icon: <ClearIcon size={14} />, hint: 'C', onSelect: () => run(s.name, 'clear') },
    ...(s.url ? [{ label: 'Open URL', icon: <ExternalIcon size={14} />, onSelect: () => window.open(s.url, '_blank', 'noreferrer') }] : []),
    { label: 'Open terminal here', icon: <TerminalIcon size={14} />, onSelect: () => onTerminal(s.name) },
    'sep',
    { label: 'Edit…', icon: <EditIcon size={14} />, hint: 'E', onSelect: () => onEdit(s.name) },
    {
      label: dependents.length ? `Delete (needed by ${dependents.join(', ')})` : 'Delete',
      icon: <TrashIcon size={14} />,
      kind: 'danger',
      disabled: dependents.length > 0,
      confirm: active ? 'Stop & delete? Click again' : 'Click again to delete',
      onSelect: () =>
        deleteService(s.name).then(
          () => onDeleted(s.name),
          (e) => setError(`delete ${s.name}: ${e.message}`),
        ),
    },
  ]
  return <ContextMenu x={x} y={y} title={s.name} items={items} onClose={onClose} />
}
