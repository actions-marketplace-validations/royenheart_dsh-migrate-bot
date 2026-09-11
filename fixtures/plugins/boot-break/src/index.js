/**
 * Every real "the plugin broke the host" case reduces to this: the module is
 * resolvable and loadable, but applying it throws during activation.
 */
export const name = 'fixture-boot-break'

export function apply() {
  throw new Error('fixture-boot-break: activate() always throws')
}
