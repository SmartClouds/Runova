import { type AppNotification, isPipelineNotification } from '@runova/core';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipcChannels';
import { store } from '../store';

/**
 * The in-app notification inbox. The pipeline watcher is what fills it today,
 * but nothing here is pipeline-specific, so it lives on its own rather than
 * inside the pipelines module where nobody would think to look for it.
 */
export function registerAppNotificationHandlers(): void {
  ipcMain.handle(IPC.appNotifications.list, (): Promise<AppNotification[]> => {
    return store.getAppNotifications();
  });

  // The badge on Pipelines counts CI results only. Other notices reach the user as a toast and a
  // row in Recent messages, and their own page (Monitoring, Deploy) has its own badge.
  ipcMain.handle(IPC.appNotifications.unreadCount, async (): Promise<number> => {
    const items = await store.getAppNotifications();
    return items.filter((item) => !item.read && isPipelineNotification(item)).length;
  });

  ipcMain.handle(
    IPC.appNotifications.markRead,
    async (_event, notificationId: string): Promise<AppNotification[]> => {
      return store.updateAppNotifications((items) =>
        items.map((item) => (item.id === notificationId ? { ...item, read: true } : item)),
      );
    },
  );

  // Mark all read is the Pipelines page's button, so it leaves other kinds of notices alone.
  ipcMain.handle(IPC.appNotifications.markAllRead, async (): Promise<AppNotification[]> => {
    return store.updateAppNotifications((items) =>
      items.map((item) =>
        item.read || !isPipelineNotification(item) ? item : { ...item, read: true },
      ),
    );
  });

  ipcMain.handle(
    IPC.appNotifications.remove,
    async (_event, notificationId: string): Promise<AppNotification[]> => {
      return store.updateAppNotifications((items) =>
        items.filter((item) => item.id !== notificationId),
      );
    },
  );
}
