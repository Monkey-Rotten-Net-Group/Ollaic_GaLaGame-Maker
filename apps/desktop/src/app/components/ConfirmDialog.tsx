import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import { buttonVariants } from './ui/button';

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm action with --destructive for irreversible or data-losing actions. */
  destructive?: boolean;
}

interface ConfirmDialogProps {
  options: ConfirmOptions | null;
  onResolve: (confirmed: boolean) => void;
}

/** Accessible confirmation built on the shared AlertDialog (focus trap, Esc, aria). */
export function ConfirmDialog({ options, onResolve }: ConfirmDialogProps) {
  return (
    <AlertDialog
      open={options !== null}
      onOpenChange={(open) => {
        if (!open) onResolve(false);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{options?.title}</AlertDialogTitle>
          {options?.description && (
            <AlertDialogDescription className="whitespace-pre-line">
              {options.description}
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => onResolve(false)}>
            {options?.cancelLabel ?? '取消'}
          </AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: options?.destructive ? 'destructive' : 'default' })}
            onClick={() => onResolve(true)}
          >
            {options?.confirmLabel ?? '确定'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
