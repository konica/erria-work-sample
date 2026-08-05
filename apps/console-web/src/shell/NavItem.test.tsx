import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { NavItem } from './NavItem.js';

describe('NavItem', () => {
  it('renders no count badge when count is omitted', () => {
    render(<NavItem icon="review" label="Review" active={false} />);
    expect(screen.queryByText(/^\d+$/)).not.toBeInTheDocument();
  });

  it('renders no count badge when count is zero', () => {
    render(<NavItem icon="review" label="Review" active={false} count={0} />);
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('renders the count badge when count is greater than zero', () => {
    render(<NavItem icon="escalation" label="Escalations" active={false} count={4} />);
    expect(screen.getByText('4')).toHaveClass('count');
  });

  it('calls onClick when provided and clicked', async () => {
    const onClick = vi.fn();
    render(<NavItem icon="sample" label="Send Audit" active={false} onClick={onClick} />);

    await userEvent.click(screen.getByRole('button', { name: /send audit/i }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
