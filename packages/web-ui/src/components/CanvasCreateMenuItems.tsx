import {
  FilmSlate,
  TextT,
  Image,
  SpeakerHigh,
  Sparkle,
  UploadSimple,
  Square,
  Cube,
  Code,
  CaretRight,
} from "@phosphor-icons/react";
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "./ui/dropdown-menu";

const creationItems = [
  { id: "assets", label: "Assets", icon: UploadSimple },
  {
    id: "actions",
    label: "Actions",
    icon: Sparkle,
    items: [
      { id: "action-badge-image", label: "Image Gen", icon: Image },
      { id: "action-badge-video", label: "Video Gen", icon: FilmSlate },
      { id: "action-badge-audio", label: "Audio Gen", icon: SpeakerHigh },
      { id: "action-badge-text", label: "Text Gen", icon: TextT },
    ],
  },
  { id: "video-editor", label: "Editor", icon: FilmSlate },
  { id: "director-stage", label: "Director Stage", icon: Cube },
  { id: "remotion-component", label: "Remotion Component", icon: Code },
  { id: "group", label: "Group", icon: Square },
  { id: "text", label: "Text", icon: TextT },
];

/** Both the toolbar and empty-canvas menu dispatch the same creation actions. */
export function CanvasCreateMenuItems({
  onSelect,
  customActions = [],
}: {
  onSelect: (type: string) => void;
  customActions?: readonly { id: string; name: string }[];
}) {
  return creationItems.map((item) => {
    const Icon = item.icon;
    if (item.items)
      return (
        <DropdownMenuSub key={item.id}>
          <DropdownMenuSubTrigger>
            <Icon className="h-4 w-4" />
            <span className="flex-1">{item.label}</span>
            <CaretRight className="h-3 w-3" />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent
            aria-label="Actions"
            className="clash-canvas-menu-surface"
          >
            {item.items.map((action) => {
              const ActionIcon = action.icon;
              return (
                <DropdownMenuItem
                  key={action.id}
                  onSelect={() => onSelect(action.id)}
                >
                  <ActionIcon className="h-4 w-4" />
                  {action.label}
                </DropdownMenuItem>
              );
            })}
            {customActions.map((action) => (
              <DropdownMenuItem key={`custom:${action.id}`} onSelect={() => onSelect(`action-badge-custom-${action.id}`)}>
                <Sparkle className="h-4 w-4" />
                {action.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      );
    return (
      <DropdownMenuItem key={item.id} onSelect={() => onSelect(item.id)}>
        <Icon className="h-4 w-4" />
        {item.label}
      </DropdownMenuItem>
    );
  });
}
