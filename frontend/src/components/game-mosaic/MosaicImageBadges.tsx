export function MosaicImageBadges({ adopted, reference }: { adopted: boolean; reference: boolean }) {
  return <>
    {adopted && <span className="game-mosaic-image-badge is-adopted">已采用</span>}
    {reference && <span className="game-mosaic-image-badge is-reference">本组基准</span>}
  </>;
}
