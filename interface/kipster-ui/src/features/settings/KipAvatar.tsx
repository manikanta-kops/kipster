import { Avatar } from '../chat/Message'

/** How a kip appears in Settings: the workspace knows colors and roles, Core knows names. */
export type KipLook = {
  name: string
  admin: boolean
  color?: string
  description?: string
}

export function KipAvatar({
  look,
  size = 'row',
}: {
  look: KipLook
  size?: 'row' | 'hero' | 'small'
}) {
  return (
    <span className={`set-avatar ${size}`}>
      <Avatar name={look.name} color={look.color} kip={look.admin} />
    </span>
  )
}
