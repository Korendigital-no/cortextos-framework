import { describe, it, expect } from 'vitest';
import { formStateFromClient, type EditClientValues } from '../edit-client-dialog';

const baseClient: EditClientValues = {
  id: 'client-1',
  company_name: 'Acme AS',
  contact_name: 'Ada',
  contact_email: 'ada@example.com',
  deal_type: 'retainer',
  rate_nok: 1500,
  rate_description: 'ex MVA',
  hours_commitment: '10/mnd',
  status: 'active',
  notes: 'First version',
};

describe('formStateFromClient', () => {
  it('maps the latest client payload into edit form strings', () => {
    expect(formStateFromClient(baseClient)).toEqual({
      companyName: 'Acme AS',
      contactName: 'Ada',
      contactEmail: 'ada@example.com',
      dealType: 'retainer',
      rateNok: '1500',
      rateDescription: 'ex MVA',
      hoursCommitment: '10/mnd',
      status: 'active',
      notes: 'First version',
    });
  });

  it('builds a fresh snapshot when refetched client props change', () => {
    const refetched: EditClientValues = {
      ...baseClient,
      company_name: 'Acme Updated AS',
      contact_name: null,
      contact_email: null,
      deal_type: null,
      rate_nok: null,
      rate_description: null,
      hours_commitment: null,
      status: 'paused',
      notes: null,
    };

    expect(formStateFromClient(refetched)).toEqual({
      companyName: 'Acme Updated AS',
      contactName: '',
      contactEmail: '',
      dealType: '',
      rateNok: '',
      rateDescription: '',
      hoursCommitment: '',
      status: 'paused',
      notes: '',
    });
  });
});
