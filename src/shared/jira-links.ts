import type { JiraLinkType } from './contracts.js';

export function isBlockingType(type?: JiraLinkType): boolean {
  return Boolean(type && (
    /^blocks?$/i.test(type.name) || /^blocks?$/i.test(type.outward) || /^блокирует$/i.test(type.outward)
  ));
}
