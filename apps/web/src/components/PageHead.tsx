import type { ReactNode } from 'react';

interface PageHeadProps {
  title: string;
  sub?: ReactNode;
  children?: ReactNode;
}

export function PageHead({ title, sub, children }: PageHeadProps) {
  return (
    <header className="page-head">
      <div className="page-head-copy">
        <h1 className="page-title">{title}</h1>
        {sub && <p className="page-head-sub">{sub}</p>}
      </div>
      {children && <div className="page-head-actions">{children}</div>}
    </header>
  );
}
