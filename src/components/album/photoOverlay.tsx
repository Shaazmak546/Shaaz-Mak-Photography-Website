import type { RenderPhotoContext } from "react-photo-album";
import { Check, Heart } from "lucide-react";
import { cn } from "@/lib/utils";

interface OverlayOptions {
  /** Photo ids the viewer has hearted. Omit to hide hearts entirely. */
  favorites?: Set<string>;
  onToggleFavorite?: (photoId: string) => void;
  /** When true, tapping a tile toggles selection instead of opening it. */
  selectMode?: boolean;
  selected?: Set<string>;
  onToggleSelect?: (photoId: string) => void;
  onOpen: (index: number) => void;
}

/**
 * react-photo-album `render.extras` that layers controls over each tile.
 *
 * The album is rendered WITHOUT its own onClick (which would make every tile a
 * <button> and nested buttons are invalid), so the "open photo" action is a
 * full-tile transparent button here, with the heart / check on top of it.
 * Pair with `componentsProps={{ wrapper: { className: "group" } }}`.
 */
export function makePhotoOverlay({
  favorites,
  onToggleFavorite,
  selectMode = false,
  selected,
  onToggleSelect,
  onOpen,
}: OverlayOptions) {
  return function PhotoOverlay(_props: object, { photo, index }: RenderPhotoContext) {
    const id = photo.key ?? "";
    const isFavorite = favorites?.has(id) ?? false;
    const isSelected = selected?.has(id) ?? false;

    return (
      <>
        <button
          type="button"
          aria-label={selectMode ? (isSelected ? "Deselect photo" : "Select photo") : "Open photo"}
          aria-pressed={selectMode ? isSelected : undefined}
          className={cn(
            "absolute inset-0 z-[1] w-full h-full cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary transition-colors",
            selectMode && !isSelected && "bg-background/35",
            selectMode && isSelected && "ring-[3px] ring-inset ring-primary",
          )}
          onClick={() => (selectMode ? onToggleSelect?.(id) : onOpen(index))}
        />

        {selectMode && (
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute top-2 left-2 z-[2] flex h-7 w-7 items-center justify-center rounded-full border-2 shadow-sm transition-all",
              isSelected
                ? "border-primary bg-primary text-primary-foreground"
                : "border-white/90 bg-black/20 text-transparent",
            )}
          >
            <Check className="h-4 w-4" strokeWidth={3} />
          </span>
        )}

        {favorites && onToggleFavorite && (
          <button
            type="button"
            aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
            aria-pressed={isFavorite}
            title={isFavorite ? "Remove from favorites" : "Add to favorites"}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(id);
            }}
            className={cn(
              "absolute top-2 right-2 z-[2] flex h-9 w-9 items-center justify-center rounded-full",
              "bg-background/80 backdrop-blur-sm shadow-sm transition-all hover:scale-110 hover:bg-background",
              isFavorite
                ? "opacity-100 text-primary"
                : "text-foreground/70 opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100",
            )}
          >
            <Heart className="h-[18px] w-[18px]" fill={isFavorite ? "currentColor" : "none"} />
          </button>
        )}
      </>
    );
  };
}
