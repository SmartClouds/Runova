import { describe, expect, it } from 'vitest';
import {
  batchStatus,
  batchTitle,
  filesLabel,
  firstName,
  formatRate,
  formatTimeLeft,
  type SendBatchView,
  sendButtonLabel,
} from './fileSend';

function batch(change: Partial<SendBatchView> = {}): SendBatchView {
  return {
    id: 'b1',
    direction: 'out',
    peer: {
      name: 'Ali Rezaei',
      email: 'ali@example.com',
      deviceName: 'Office PC',
      platform: 'windows',
      kind: 'computer',
      relation: 'teammate',
      remoteId: '482193775',
    },
    phase: 'transferring',
    reason: null,
    note: null,
    fileCount: 35,
    files: [],
    moreFiles: 0,
    totalBytes: 1_500_000_000,
    transferredBytes: 0,
    doneFiles: 2,
    failedFiles: 0,
    bytesPerSecond: 19_083_264,
    secondsLeft: 70,
    startedAt: 0,
    finishedAt: null,
    answerBy: null,
    folder: null,
    transport: 'direct',
    ...change,
  };
}

describe('send wording', () => {
  it('counts files the way a person says them', () => {
    expect(filesLabel(1)).toBe('1 file');
    expect(filesLabel(35)).toBe('35 files');
    expect(filesLabel(10_000)).toBe('10,000 files');
  });

  it('uses the first name, or the whole name when there is only one', () => {
    expect(firstName('Ali Rezaei')).toBe('Ali');
    expect(firstName('Sam')).toBe('Sam');
    expect(firstName('')).toBe('Someone');
  });

  it('writes a speed per second', () => {
    expect(formatRate(19_083_264)).toBe('18.2 MB/s');
    expect(formatRate(900)).toBe('900 B/s');
  });

  it('rounds the time left so it does not flicker', () => {
    expect(formatTimeLeft(20)).toBe('less than a minute left');
    expect(formatTimeLeft(70)).toBe('about 1 min left');
    expect(formatTimeLeft(3 * 60 + 40)).toBe('about 4 min left');
    expect(formatTimeLeft(2 * 3600 + 10 * 60)).toBe('about 2 h 10 min left');
  });

  it('names who a batch is with', () => {
    expect(batchTitle(batch())).toBe('To Office PC');
    expect(batchTitle(batch({ direction: 'in' }))).toBe('From Ali Rezaei');
  });

  it('says what a batch is doing in every phase', () => {
    expect(batchStatus(batch({ phase: 'connecting' }), 0)).toBe('Reaching Office PC…');
    expect(batchStatus(batch({ phase: 'waiting', answerBy: 52_000 }), 0)).toBe(
      'Waiting for Ali to accept, 52 s',
    );
    expect(batchStatus(batch({ direction: 'in', phase: 'asking' }), 0)).toBe(
      'Waiting for your answer',
    );
    expect(batchStatus(batch(), 0)).toBe('Sending 3 of 35, 18.2 MB/s, about 1 min left');
    expect(batchStatus(batch({ direction: 'in' }), 0)).toBe(
      'Receiving 3 of 35, 18.2 MB/s, about 1 min left',
    );
    expect(batchStatus(batch({ bytesPerSecond: null, secondsLeft: null }), 0)).toBe(
      'Sending 3 of 35',
    );
    expect(batchStatus(batch({ phase: 'reconnecting' }), 0)).toBe(
      'Reconnecting, it picks up where it stopped',
    );
    expect(batchStatus(batch({ phase: 'done', doneFiles: 35 }), 0)).toBe(
      'Sent 35 files, 1.4 GB, verified',
    );
    expect(batchStatus(batch({ direction: 'in', phase: 'done', doneFiles: 35 }), 0)).toBe(
      'Received 35 files, 1.4 GB, verified',
    );
    expect(batchStatus(batch({ phase: 'done', doneFiles: 33, failedFiles: 2 }), 0)).toBe(
      'Sent 33 of 35 files, 2 failed',
    );
    expect(batchStatus(batch({ phase: 'declined', reason: 'Declined by Ali.' }), 0)).toBe(
      'Declined by Ali.',
    );
    expect(batchStatus(batch({ phase: 'failed', reason: null }), 0)).toBe('It did not go through.');
  });

  it('labels the send button with what goes where', () => {
    expect(sendButtonLabel(35, 'Office PC')).toBe('Send 35 files to Office PC');
    expect(sendButtonLabel(1, null)).toBe('Send 1 file');
    expect(sendButtonLabel(0, 'Office PC')).toBe('Send');
  });
});
