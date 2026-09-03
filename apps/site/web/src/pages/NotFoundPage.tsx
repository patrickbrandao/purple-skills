import { Link } from 'react-router-dom';
import { ArrowLeftIcon } from '../components/Icons.js';

export function NotFoundPage() {
  return (
    <section className="skill-page">
      <div className="wrap">
        <div className="empty" style={{ maxWidth: '30rem', margin: '40px auto' }}>
          <img className="wiz" src="/assets/images/icon-purple-right-137x158.png" alt="" />
          <p
            className="display grad-text"
            style={{ fontSize: '3.4rem', lineHeight: 1, marginBottom: '10px' }}
          >
            404
          </p>
          <h3>O mago não encontrou esta página.</h3>
          <p>O feitiço pode ter expirado — ou o endereço veio torto.</p>
          <Link to="/" className="btn btn-primary" style={{ marginTop: '22px' }}>
            <ArrowLeftIcon /> Voltar ao catálogo
          </Link>
        </div>
      </div>
    </section>
  );
}
